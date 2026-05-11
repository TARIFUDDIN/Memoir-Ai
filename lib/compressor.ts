/**
 * lib/compressor.ts
 *
 * Context compression — strips irrelevant sentences from retrieved chunks
 * before passing them to the final LLM.
 *
 * Free-tier Groq limits (on_demand):
 *   llama-3.1-8b-instant  → 6,000 TPM
 *   llama-3.3-70b-versatile → 12,000 TPM
 *
 * Strategy: truncate each chunk to MAX_CHUNK_CHARS before sending,
 * then ask the model to extract only the relevant parts.
 * If the model still errors (rate-limit or 413), fall back to the
 * truncated text as-is — never crash the whole pipeline.
 */

import Groq from "groq-sdk"

const groq = new Groq( { apiKey: process.env.GROQ_API_KEY! } )

// llama-3.1-8b-instant is ~4 chars/token → 4000 tokens ≈ 16 000 chars
// Keep well below 6K TPM: system prompt ~200 tokens + question ~50 tokens
// → leave ~1500 tokens for the chunk content (= ~6000 chars)
const MAX_CHUNK_CHARS = 3000   // hard truncate before sending
const COMPRESSION_MODEL = "llama-3.1-8b-instant"
const MAX_OUTPUT_TOKENS = 250    // we only want the compressed excerpt

export type CompressedChunk = {
  id: string
  content: string
  metadata: Record<string, unknown>
  score?: number
  rerankScore?: number
  source?: string
  compressionRatio: number
  wasCompressed: boolean
}

// ─── Single chunk ──────────────────────────────────────────────────────────

async function compressChunk (
  chunk: { id: string; content: string; metadata: Record<string, unknown> },
  question: string
): Promise<CompressedChunk>
{
  const original = chunk.content

  // Hard truncate — never send more than MAX_CHUNK_CHARS to Groq
  const truncated = original.length > MAX_CHUNK_CHARS
    ? original.slice( 0, MAX_CHUNK_CHARS ) + "…"
    : original

  try
  {
    const response = await groq.chat.completions.create( {
      model: COMPRESSION_MODEL,
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: "system",
          content: "Extract only the sentences directly relevant to the question. Return the extracted text only — no preamble, no explanation.",
        },
        {
          role: "user",
          content: `Question: ${ question }\n\nText:\n${ truncated }`,
        },
      ],
    } )

    const compressed = response.choices[ 0 ]?.message?.content?.trim() ?? ""

    if ( !compressed || compressed.length < 10 )
    {
      // Model returned nothing useful — use truncated original
      return {
        ...chunk,
        content: truncated,
        compressionRatio: truncated.length / original.length,
        wasCompressed: false,
      }
    }

    return {
      ...chunk,
      content: compressed,
      compressionRatio: compressed.length / original.length,
      wasCompressed: true,
    }
  } catch ( err )
  {
    // Rate limit or any other error → fall back silently to truncated original
    console.warn( `⚠️ Compression failed for chunk, using truncated original:`, ( err as Error ).message?.slice( 0, 120 ) )
    return {
      ...chunk,
      content: truncated,
      compressionRatio: truncated.length / original.length,
      wasCompressed: false,
    }
  }
}

// ─── Batch with concurrency cap ────────────────────────────────────────────
// Free tier: 6K TPM shared across all concurrent requests.
// Run sequentially (concurrency=1) to avoid smashing the limit.
// With truncation at 3K chars ≈ 750 tokens per chunk, 6 chunks = ~4.5K tokens — safe.

export async function compressChunks (
  chunks: Array<{ id: string; content: string; metadata: Record<string, unknown>; score?: number; rerankScore?: number; source?: string }>,
  question: string,
  concurrency = 1
): Promise<CompressedChunk[]>
{
  const results: CompressedChunk[] = []

  // Process in batches of `concurrency`
  for ( let i = 0; i < chunks.length; i += concurrency )
  {
    const batch = chunks.slice( i, i + concurrency )
    const batchResults = await Promise.all(
      batch.map( chunk => compressChunk( chunk, question ) )
    )
    results.push( ...batchResults )
  }
  return results
}