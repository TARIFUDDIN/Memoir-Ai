/**
 * lib/retrieval/types.ts
 *
 * Canonical types shared across all retrievers in the hybrid retrieval layer.
 * Every adapter (Vector, Graph, BM25) normalizes its output into RetrievedContext
 * so downstream scoring, deduplication, and compression can operate generically.
 */

// ---------------------------------------------------------------------------
// Source identifiers
// ---------------------------------------------------------------------------

export type RetrievalSource = "vector" | "graph" | "bm25"

// ---------------------------------------------------------------------------
// Core context type
// ---------------------------------------------------------------------------

/**
 * A single unit of retrieved context, regardless of origin.
 *
 * @field id            - Stable identifier (chunk ID, node ID, or BM25 doc ID).
 * @field content       - The raw text content to be fed into the LLM context window.
 * @field source        - Which retriever produced this result.
 * @field confidenceScore - Raw retrieval score, normalised to [0, 1] by each adapter.
 *                         Vector: cosine similarity. BM25: BM25 score (normalised).
 *                         Graph: structural heuristic [0, 1].
 * @field timestamp     - ISO-8601 string or Date of the originating meeting/event.
 *                        Used by the temporal decay function in scoring.ts.
 * @field metadata      - Arbitrary key/value bag forwarded from the underlying store.
 *                        Typical keys: meetingId, title, speaker, chunkIndex.
 */
export type RetrievedContext = {
  id: string
  content: string
  source: RetrievalSource
  confidenceScore: number         // [0, 1]
  timestamp: Date | null          // null = unknown / graph-derived with no date
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Retriever interface — implemented by every adapter
// ---------------------------------------------------------------------------

export interface Retriever {
  /**
   * Retrieve contexts relevant to `query`.
   * @param query   Natural-language question or keyword string.
   * @param topK    Maximum number of results to return.
   * @param filter  Optional source-specific filter (e.g. Pinecone metadata filter).
   */
  retrieve(
    query: string,
    topK?: number,
    filter?: Record<string, unknown>
  ): Promise<RetrievedContext[]>
}

// ---------------------------------------------------------------------------
// Helper — safe date parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw value from metadata/DB into a Date, or return null if unparseable.
 */
export function parseTimestamp(raw: unknown): Date | null {
  if (!raw) return null
  const d = raw instanceof Date ? raw : new Date(String(raw))
  return isNaN(d.getTime()) ? null : d
}
