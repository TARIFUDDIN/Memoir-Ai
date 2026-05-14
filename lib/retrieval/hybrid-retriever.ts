/**
 * lib/retrieval/hybrid-retriever.ts
 *
 * Phase 1.5 — Hybrid Retrieval Orchestrator
 *
 * Coordinates the three retrieval adapters (Vector, BM25, Graph) in parallel,
 * normalises scores, deduplicates, reranks via Cohere, and enforces a token
 * budget — returning a single clean RetrievedContext[] ready for prompt
 * injection.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. Parallel retrieval   — VectorRetriever + BM25Retriever + GraphRetriever
 *                             all execute concurrently via Promise.allSettled.
 *                             Any individual adapter failure is logged and
 *                             gracefully skipped (never throws).
 *
 *   2. Flatten + score      — All results merged into one array, each item
 *                             passed through scoreContext() which applies
 *                             source-weight × semantic-score × temporal-decay.
 *                             Results sorted descending by finalScore.
 *
 *   3. Compress             — compressRetrievals() deduplicates near-identical
 *                             chunks (Jaccard trigram), reranks via Cohere, and
 *                             trims to the token budget.
 *
 *   4. Return               — Final RetrievedContext[] with confidenceScore
 *                             overwritten by Cohere relevance score.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-query support
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pass multiple query variants via `retrieve(queries, userId)`.  Every adapter
 * is called once per variant; dedup at the score layer ensures no duplicate
 * content reaches the compressor.  The original question (queries[0]) is used
 * as the Cohere rerank query.
 */

import { type RetrievedContext, type Retriever } from "./types"
import { scoreContext } from "./scoring"
import { compressRetrievals } from "./context-compressor"
import { VectorRetriever } from "./vector-retriever"
import { BM25Retriever } from "./bm25-retriever"
import { GraphRetriever } from "./graph-retriever"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How many raw results to request from each adapter per query variant. */
const ADAPTER_TOP_K = 12

/** Token budget passed to the compressor. Stays well under LLM context limits. */
const MAX_TOKENS = 3_000

/** Number of top results requested from Cohere rerank inside the compressor. */
const RERANK_TOP_N = 10

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a single retriever safely — logs failures without propagating them.
 */
async function safeRetrieve (
    retriever: Retriever,
    query: string,
    topK: number,
    filter?: Record<string, unknown>
): Promise<RetrievedContext[]>
{
    try
    {
        return await retriever.retrieve( query, topK, filter )
    } catch ( err )
    {
        console.error(
            `⚠️  HybridRetriever: adapter ${ retriever.constructor.name } failed for query "${ query.slice( 0, 60 ) }…":`,
            err instanceof Error ? err.message : err
        )
        return []
    }
}

/**
 * Deduplicate an array of RetrievedContext by id, keeping the entry with the
 * highest confidenceScore when duplicates arrive from multiple query variants.
 */
function deduplicateById (
    contexts: RetrievedContext[]
): RetrievedContext[]
{
    const seen = new Map<string, RetrievedContext>()

    for ( const ctx of contexts )
    {
        const existing = seen.get( ctx.id )
        if ( !existing || ctx.confidenceScore > existing.confidenceScore )
        {
            seen.set( ctx.id, ctx )
        }
    }

    return [ ...seen.values() ]
}

// ---------------------------------------------------------------------------
// HybridRetriever
// ---------------------------------------------------------------------------

export interface HybridRetrieverOptions
{
    /**
     * Adapters to use.  Defaults to [VectorRetriever, BM25Retriever, GraphRetriever].
     * Override in tests or specialised pipelines.
     */
    retrievers?: Retriever[]

    /** Per-adapter top-K. Default: 12. */
    adapterTopK?: number

    /** Token budget for the compressor. Default: 3 000. */
    maxTokens?: number

    /** Number of results to request from Cohere rerank. Default: 10. */
    rerankTopN?: number
}

export class HybridRetriever
{
    private readonly retrievers: Retriever[]
    private readonly adapterTopK: number
    private readonly maxTokens: number
    private readonly rerankTopN: number

    constructor ( options: HybridRetrieverOptions = {} )
    {
        this.retrievers = options.retrievers ?? [
            new VectorRetriever(),
            new BM25Retriever(),
            new GraphRetriever(),
        ]
        this.adapterTopK = options.adapterTopK ?? ADAPTER_TOP_K
        this.maxTokens = options.maxTokens ?? MAX_TOKENS
        this.rerankTopN = options.rerankTopN ?? RERANK_TOP_N
    }

    /**
     * Retrieve, score, deduplicate, rerank, and token-trim context for `queries`.
     *
     * @param queries   One or more query strings.  queries[0] is treated as the
     *                  canonical question for Cohere rerank; additional entries are
     *                  expanded variants used only for broader retrieval coverage.
     * @param userId    Scopes vector and BM25 searches to this user's corpus.
     * @param filter    Optional extra filter forwarded to every adapter.
     *
     * @returns         Final, compressed RetrievedContext[] sorted by relevance.
     */
    async retrieve (
        queries: string | string[],
        userId: string,
        filter?: Record<string, unknown>
    ): Promise<RetrievedContext[]>
    {
        const queryList = Array.isArray( queries ) ? queries : [ queries ]
        const primaryQuery = queryList[ 0 ]

        if ( !primaryQuery?.trim() )
        {
            console.warn( "⚠️  HybridRetriever: empty query — returning []" )
            return []
        }

        const adapterFilter = { userId, ...filter }

        // ── Step 1: Parallel retrieval across all adapters × all query variants ──

        // Build one promise per (adapter, query) combination
        const retrievalPromises = this.retrievers.flatMap( ( retriever ) =>
            queryList.map( ( query ) =>
                safeRetrieve( retriever, query, this.adapterTopK, adapterFilter )
            )
        )

        const rawBatches = await Promise.allSettled( retrievalPromises )

        // Collect fulfilled results; safeRetrieve already handles rejections,
        // but allSettled gives us an extra safety net.
        const allRaw: RetrievedContext[] = rawBatches.flatMap( ( result ) =>
            result.status === "fulfilled" ? result.value : []
        )

        console.log(
            `🔍 HybridRetriever: ${ allRaw.length } raw results from ` +
            `${ this.retrievers.length } adapters × ${ queryList.length } queries`
        )

        if ( allRaw.length === 0 ) return []

        // ── Step 2: ID-level dedup (same chunk returned by multiple adapters/queries) ──
        const idDeduped = deduplicateById( allRaw )

        // ── Step 3: Apply unified scoring (source weight × semantic × temporal decay) ──
        const scored = idDeduped
            .map( ( ctx ) => ( { ctx, finalScore: scoreContext( ctx ) } ) )
            .sort( ( a, b ) => b.finalScore - a.finalScore )
            .map( ( { ctx, finalScore } ) => ( {
                ...ctx,
                // Surface the composite score so the compressor can use it for pre-sort
                confidenceScore: finalScore,
            } ) )

        console.log(
            `📊 HybridRetriever: ${ idDeduped.length } unique candidates after id-dedup, ` +
            `top score: ${ scored[ 0 ]?.confidenceScore.toFixed( 3 ) ?? "n/a" }`
        )

        // ── Step 4: Compress (trigram dedup → Cohere rerank → token trim) ──────────
        const compressed = await compressRetrievals(
            scored,
            primaryQuery,
            this.maxTokens,
            this.rerankTopN
        )

        console.log(
            `✅ HybridRetriever: ${ compressed.length } contexts ready for prompt injection`
        )

        return compressed
    }
}

// ---------------------------------------------------------------------------
// Convenience factory — matches the call-site pattern used in rag.ts
// ---------------------------------------------------------------------------

/**
 * Create and return a default HybridRetriever instance.
 * Exported as a function so callers don't need to manage the class lifecycle.
 *
 * Usage:
 *   const retriever = createHybridRetriever()
 *   const contexts  = await retriever.retrieve(queries, userId)
 */
export function createHybridRetriever (
    options?: HybridRetrieverOptions
): HybridRetriever
{
    return new HybridRetriever( options )
}