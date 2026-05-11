/**
 * rag.ts — Hybrid RAG pipeline
 *
 * PHASE 1: BM25 + Cohere reranker + multi-query retrieval
 * PHASE 2: Parent-child chunking + context compression + Redis cache
 *
 * chatWithMeeting     — single-meeting scoped Q&A
 * chatWithAllMeetings — global hybrid search (fully upgraded)
 */

import { prisma } from "./db"
import { chatWithAI, createEmbedding, createManyEmbeddings } from "./openai"
import { saveManyVectors, searchVectors } from "./pinecone"
import { chunkTranscriptParentChild, chunkTranscript, extractSpeaker } from "./text-chunker"
import { queryGraphMemory } from "./graph"
import { BM25Index, type BM25Document } from "./bm25"
import { cohereRerank, type CandidateDoc } from "./reranker"
import { compressChunks } from "./compressor"
import { getCachedResponse, setCachedResponse } from "./cache"
import Groq from "groq-sdk"

const groq = new Groq( { apiKey: process.env.GROQ_API_KEY! } )

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const VECTOR_TOP_K = 12   // fetch more than needed before rerank
const BM25_TOP_K = 12
const RERANK_TOP_N = 4    // ← was 6; fewer docs = less total context sent to LLM
const MULTI_QUERY_N = 3    // query variants to generate

// ─────────────────────────────────────────────
// INGEST  — Phase 2: parent-child chunking
// ─────────────────────────────────────────────

export async function processTranscript (
  meetingId: string,
  userId: string,
  transcript: string,
  meetingTitle?: string
)
{
  // Use new parent-child chunker
  const childChunks = chunkTranscriptParentChild( transcript )

  if ( childChunks.length === 0 )
  {
    // Fallback to legacy chunker if transcript is too short to split
    const legacyChunks = chunkTranscript( transcript )
    const texts = legacyChunks.map( c => c.content )
    const embeddings = await createManyEmbeddings( texts )

    await prisma.transcriptChunk.createMany( {
      data: legacyChunks.map( c => ( {
        meetingId,
        chunkIndex: c.chunkIndex,
        content: c.content,
        speakerName: extractSpeaker( c.content ),
        vectorId: `${ meetingId }_chunk_${ c.chunkIndex }`,
        isChildChunk: false,
      } ) ),
      skipDuplicates: true,
    } )

    await saveManyVectors(
      legacyChunks.map( ( c, i ) => ( {
        id: `${ meetingId }_chunk_${ c.chunkIndex }`,
        embedding: embeddings[ i ],
        metadata: {
          meetingId,
          userId,
          chunkIndex: c.chunkIndex,
          content: c.content,
          speakerName: extractSpeaker( c.content ) ?? "",
          meetingTitle: meetingTitle ?? "Untitled Meeting",
          hasParent: false,
        },
      } ) )
    )
    return
  }

  // Embed only the small child contents → Pinecone gets precise chunks
  const texts = childChunks.map( c => c.content )
  const embeddings = await createManyEmbeddings( texts )

  // Store child chunks in DB — parentContent lives here, NOT in Pinecone
  // (Pinecone metadata has a 40KB limit per vector; parent text can exceed that)
  await prisma.transcriptChunk.createMany( {
    data: childChunks.map( c => ( {
      meetingId,
      chunkIndex: c.chunkIndex,
      content: c.content,
      speakerName: extractSpeaker( c.content ),
      vectorId: `${ meetingId }_chunk_${ c.chunkIndex }`,
      parentContent: c.parentContent,
      parentChunkId: c.parentChunkId,
      isChildChunk: true,
    } ) ),
    skipDuplicates: true,
  } )

  // Pinecone vectors: embed child content, store parentChunkId in metadata
  // so we can fetch the parent from DB at query time
  await saveManyVectors(
    childChunks.map( ( c, i ) => ( {
      id: `${ meetingId }_chunk_${ c.chunkIndex }`,
      embedding: embeddings[ i ],
      metadata: {
        meetingId,
        userId,
        chunkIndex: c.chunkIndex,
        content: c.content,           // child — for BM25 matching
        speakerName: extractSpeaker( c.content ) ?? "",
        meetingTitle: meetingTitle ?? "Untitled Meeting",
        parentChunkId: c.parentChunkId ?? "",
        hasParent: true,
      },
    } ) )
  )
}

// ─────────────────────────────────────────────
// SINGLE-MEETING CHAT  (no change to interface)
// ─────────────────────────────────────────────

export async function chatWithMeeting (
  userId: string,
  meetingId: string,
  question: string
)
{
  const questionEmbedding = await createEmbedding( question )

  const results = await searchVectors(
    questionEmbedding,
    { userId, meetingId },
    5
  )

  const meeting = await prisma.meeting.findUnique( { where: { id: meetingId } } )

  const context = results
    .map( r => `${ r.metadata?.speakerName || "Unknown" }: ${ r.metadata?.content || "" }` )
    .join( "\n\n" )

  const systemPrompt = `You are helping someone understand their meeting.
Meeting: ${ meeting?.title || "Untitled Meeting" }
Date: ${ meeting?.createdAt ? new Date( meeting.createdAt ).toDateString() : "Unknown" }

Here's what was discussed:
${ context }

Answer the user's question based only on the meeting content above. If the answer isn't in the meeting, say so.`

  const answer = await chatWithAI( systemPrompt, question )

  return {
    answer,
    sources: results.map( r => ( {
      meetingId: r.metadata?.meetingId,
      content: r.metadata?.content,
      speakerName: r.metadata?.speakerName,
      confidence: r.score,
    } ) ),
  }
}

// ─────────────────────────────────────────────
// STEP 1: MULTI-QUERY EXPANSION
// ─────────────────────────────────────────────

async function expandQuery ( question: string ): Promise<string[]>
{
  try
  {
    const response = await groq.chat.completions.create( {
      model: "llama-3.3-70b-versatile",
      temperature: 0.6,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Generate ${ MULTI_QUERY_N } distinct rephrasings of the user's question.
Each rephrasing should approach the same information need from a different angle.
Return ONLY valid JSON: { "queries": ["query1", "query2", "query3"] }`,
        },
        { role: "user", content: question },
      ],
    } )

    const raw = response.choices[ 0 ]?.message?.content || "{}"
    const parsed = JSON.parse( raw ) as { queries?: string[] }
    const variants = parsed.queries ?? []

    // Always include the original
    return [ question, ...variants ].slice( 0, MULTI_QUERY_N + 1 )
  } catch ( err )
  {
    console.warn( "⚠️ Multi-query expansion failed, using original:", err )
    return [ question ]
  }
}

// ─────────────────────────────────────────────
// STEP 2: VECTOR SEARCH ACROSS ALL QUERY VARIANTS
// ─────────────────────────────────────────────

async function multiQueryVectorSearch (
  queries: string[],
  userId: string
): Promise<CandidateDoc[]>
{
  // Embed all queries in one call
  const embeddings = await createManyEmbeddings( queries )

  // Run Pinecone searches in parallel
  const searchResults = await Promise.all(
    embeddings.map( embedding =>
      searchVectors( embedding, { userId }, VECTOR_TOP_K )
    )
  )

  // Flatten + deduplicate by vectorId, keep highest score per doc
  const seen = new Map<string, CandidateDoc>()

  for ( const results of searchResults )
  {
    for ( const r of results )
    {
      const id = String( r.id ?? r.metadata?.vectorId ?? "" )
      const existing = seen.get( id )
      const score = r.score ?? 0

      if ( !existing || score > ( existing.score ?? 0 ) )
      {
        seen.set( id, {
          id,
          content: String( r.metadata?.content ?? "" ),
          metadata: r.metadata as Record<string, unknown>,
          score,
          source: "vector",
        } )
      }
    }
  }

  return [ ...seen.values() ]
}

// ─────────────────────────────────────────────
// STEP 3: BM25 KEYWORD SEARCH
// ─────────────────────────────────────────────

async function bm25Search (
  question: string,
  userId: string
): Promise<CandidateDoc[]>
{
  const userMeetings = await prisma.meeting.findMany( {
    where: { createdById: userId },
    select: { id: true, title: true },
  } )

  if ( userMeetings.length === 0 ) return []

  const meetingIdToTitle = new Map( userMeetings.map( m => [ m.id, m.title ] ) )
  const meetingIds = userMeetings.map( m => m.id )

  const chunks = await prisma.transcriptChunk.findMany( {
    where: {
      meetingId: { in: meetingIds },
    },
    select: {
      vectorId: true,
      content: true,
      speakerName: true,
      meetingId: true,
      chunkIndex: true,
    },
    take: 2000,
  } )

  if ( chunks.length === 0 ) return []

  const docs: BM25Document[] = chunks.map( c => ( {
    id: c.vectorId ?? `${ c.meetingId }_chunk_${ c.chunkIndex }`,
    content: c.content,
    metadata: {
      meetingId: c.meetingId,
      speakerName: c.speakerName ?? "",
      meetingTitle: meetingIdToTitle.get( c.meetingId ) ?? "Untitled Meeting",
      content: c.content,
    },
  } ) )

  const index = new BM25Index().build( docs )
  const results = index.search( question, BM25_TOP_K )

  return results.map( r => ( {
    id: r.id,
    content: r.content,
    metadata: r.metadata,
    score: r.score,
    source: "bm25" as const,
  } ) )
}

// ─────────────────────────────────────────────
// STEP 4: MERGE vector + BM25, mark overlap
// ─────────────────────────────────────────────

function mergeResults (
  vectorDocs: CandidateDoc[],
  bm25Docs: CandidateDoc[]
): CandidateDoc[]
{
  const merged = new Map<string, CandidateDoc>()

  for ( const doc of vectorDocs )
  {
    merged.set( doc.id, { ...doc, source: "vector" } )
  }

  for ( const doc of bm25Docs )
  {
    const existing = merged.get( doc.id )
    if ( existing )
    {
      merged.set( doc.id, {
        ...existing,
        source: "both",
        score: ( existing.score ?? 0 ) + ( doc.score ?? 0 ) * 0.3,
      } )
    } else
    {
      merged.set( doc.id, doc )
    }
  }

  return [ ...merged.values() ].sort( ( a, b ) => ( b.score ?? 0 ) - ( a.score ?? 0 ) )
}

// ─────────────────────────────────────────────
// PARENT EXPANSION
// ─────────────────────────────────────────────

async function expandToParentContent<T extends { id: string; metadata: Record<string, unknown> }> (
  docs: T[]
): Promise<( T & { content: string } )[]>
{
  const parentChunkIds = docs
    .map( d => d.metadata?.parentChunkId as string | undefined )
    .filter( ( id ): id is string => !!id )

  if ( parentChunkIds.length === 0 )
  {
    return docs.map( d => ( {
      ...d,
      content: String( d.metadata?.content ?? "" ),
    } ) )
  }

  const parentRows = await prisma.transcriptChunk.findMany( {
    where: { parentChunkId: { in: parentChunkIds } },
    select: { parentChunkId: true, parentContent: true },
    distinct: [ "parentChunkId" ],
  } )

  const parentMap = new Map(
    parentRows.map( r => [ r.parentChunkId!, r.parentContent ?? "" ] )
  )

  return docs.map( d =>
  {
    const pid = d.metadata?.parentChunkId as string | undefined
    const parentContent = pid ? parentMap.get( pid ) : undefined
    return {
      ...d,
      content: parentContent || String( d.metadata?.content ?? "" ),
    }
  } )
}

// ─────────────────────────────────────────────
// UPGRADED: GLOBAL HYBRID CHAT  (Phase 1 + 2)
// ─────────────────────────────────────────────

export async function chatWithAllMeetings ( userId: string, question: string )
{
  console.log( `🧠 Hybrid RAG: "${ question }"` )

  // ── Redis cache check ─────────────────────────────────────
  const cached = await getCachedResponse( question, userId )
  if ( cached )
  {
    console.log( "⚡ Cache hit" )
    return { answer: cached, sources: [], fromCache: true }
  }

  // ── Expand query ──────────────────────────────────────────
  const queries = await expandQuery( question )
  console.log( `📝 Query variants: ${ queries.length }` )

  // ── Parallel: multi-query vector, BM25, Neo4j ────────────
  const [ vectorDocs, bm25Docs, graphKnowledge ] = await Promise.all( [
    multiQueryVectorSearch( queries, userId ),
    bm25Search( question, userId ),
    queryGraphMemory( question ),
  ] )

  console.log( `🔍 Vector: ${ vectorDocs.length } | BM25: ${ bm25Docs.length }` )

  // ── Merge ─────────────────────────────────────────────────
  const merged = mergeResults( vectorDocs, bm25Docs )
  console.log( `🔀 Merged: ${ merged.length } unique candidates` )

  // ── Rerank ────────────────────────────────────────────────
  const reranked = await cohereRerank( question, merged, RERANK_TOP_N )
  console.log( `✅ Reranked → top ${ reranked.length } docs` )

  // ── Phase 2a: Expand child → parent content ───────────────
  const expanded = await expandToParentContent( reranked )
  console.log( `📖 Parent expansion complete` )

  // ── Phase 2b: Context compression ─────────────────────────
  // compressor.ts now hard-truncates each chunk to 3K chars before
  // sending to Groq, keeping well within the 6K TPM free-tier limit.
  // Runs sequentially (concurrency=1) to avoid burst rate-limit hits.
  const compressed = await compressChunks( expanded, question )
  const avgRatio = compressed.reduce( ( s, c ) => s + c.compressionRatio, 0 ) / compressed.length
  console.log( `✂️ Compression done. Avg ratio: ${ ( avgRatio * 100 ).toFixed( 0 ) }% of original` )

  // ── Build hybrid super-context (token-capped) ─────────────
  // llama-3.3-70b-versatile free tier: 12K TPM
  // System prompt overhead ≈ 300 tokens, question ≈ 100 tokens
  // → leave ~3000 tokens for context ≈ 12 000 chars total
  // Split between graph knowledge and transcript excerpts.
  const MAX_GRAPH_CHARS = 1200
  const MAX_CONTEXT_CHARS = 5000

  const graphKnowledgeCapped = ( graphKnowledge ?? "" ).slice( 0, MAX_GRAPH_CHARS )

  const contextLines: string[] = []
  let budgetLeft = MAX_CONTEXT_CHARS

  for ( const r of compressed )
  {
    const title = String( r.metadata?.meetingTitle ?? "Untitled Meeting" )
    const speaker = String( r.metadata?.speakerName ?? "Unknown" )
    const tag = r.source === "both" ? " [★]" : ""
    const line = `[${ title }]${ tag } ${ speaker }: ${ r.content }`

    if ( line.length >= budgetLeft )
    {
      // Truncate this line to fit remaining budget
      contextLines.push( line.slice( 0, budgetLeft ) + "…" )
      break
    }
    contextLines.push( line )
    budgetLeft -= line.length + 2  // +2 for \n\n separator
    if ( budgetLeft <= 0 ) break
  }

  const vectorContext = contextLines.join( "\n\n" )

  const systemPrompt = `You are an AI assistant with access to corporate meeting memory.

KNOWLEDGE GRAPH (structured facts):
${ graphKnowledgeCapped || "No graph data." }

TRANSCRIPT EXCERPTS (raw discussion):
${ vectorContext }

Instructions:
- Synthesise both sources to answer accurately.
- [★] means the excerpt was found by BOTH keyword and semantic search — highly reliable.
- If sources conflict, the transcript is the ground truth.
- If the answer is not in either source, say so clearly.`

  const answer = await chatWithAI( systemPrompt, question )

  // ── Cache the answer ──────────────────────────────────────
  await setCachedResponse( question, answer, userId )

  return {
    answer,
    fromCache: false,
    sources: reranked.map( ( r, i ) => ( {
      meetingId: r.metadata?.meetingId,
      meetingTitle: r.metadata?.meetingTitle,
      content: compressed[ i ]?.content ?? r.content,
      speakerName: r.metadata?.speakerName,
      confidence: r.rerankScore,
      source: r.source,
      wasCompressed: compressed[ i ]?.wasCompressed ?? false,
    } ) ),
    debug: {
      queryVariants: queries,
      vectorCandidates: vectorDocs.length,
      bm25Candidates: bm25Docs.length,
      mergedCandidates: merged.length,
      finalDocs: reranked.length,
      avgCompressionRatio: avgRatio,
    },
  }
}