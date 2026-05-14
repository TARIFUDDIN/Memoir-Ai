/**
 * lib/retrieval/bm25-retriever.ts
 *
 * Adapter that wraps lib/bm25.ts `BM25Index` and normalises scored results
 * into RetrievedContext objects.
 *
 * BM25 scores are unbounded positive floats. We normalise them to [0, 1]
 * using min-max scaling within each result set. When there is only one
 * result its score is 1.0.
 *
 * Corpus management:
 *   BM25 requires the full document corpus to be held in memory at query time.
 *   This adapter owns a `BM25Index` instance and exposes `loadCorpus()` so the
 *   caller (e.g. the orchestrator in Phase 1.5) can (re)build the index whenever
 *   meetings are added or the server restarts.
 *
 *   For large corpora you may want to shard by meetingId — that optimisation
 *   can be layered on top of this interface without changing the Retriever contract.
 */

import { BM25Index, type BM25Document } from "@/lib/bm25"
import { type RetrievedContext, type Retriever, parseTimestamp } from "./types"

// ---------------------------------------------------------------------------
// Score normalisation
// ---------------------------------------------------------------------------

/**
 * Min-max normalise an array of raw BM25 scores into [0, 1].
 * Returns an array of the same length with normalised values.
 */
function minMaxNormalise(scores: number[]): number[] {
  if (scores.length === 0) return []
  if (scores.length === 1) return [1]

  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min

  // All scores identical → assign 0.5 (not 0 — content is still relevant)
  if (range === 0) return scores.map(() => 0.5)

  return scores.map((s) => (s - min) / range)
}

// ---------------------------------------------------------------------------
// BM25Retriever
// ---------------------------------------------------------------------------

export class BM25Retriever implements Retriever {
  private index: BM25Index = new BM25Index()
  private corpusLoaded = false

  /**
   * (Re)build the BM25 index from a fresh corpus.
   * Call this on server startup and whenever new meetings are ingested.
   *
   * @param docs  Array of BM25Document — id, content, metadata.
   */
  loadCorpus(docs: BM25Document[]): void {
    if (docs.length === 0) {
      console.warn("⚠️ BM25Retriever.loadCorpus: received empty corpus")
      this.corpusLoaded = false
      return
    }
    this.index.build(docs)
    this.corpusLoaded = true
    console.log(`✅ BM25Retriever: index built with ${docs.length} documents`)
  }

  /**
   * Returns true when the index has been populated with at least one document.
   */
  isReady(): boolean {
    return this.corpusLoaded
  }

  async retrieve(
    query: string,
    topK: number = 10,
    filter: Record<string, unknown> = {}
  ): Promise<RetrievedContext[]> {
    if (!query?.trim()) return []

    if (!this.corpusLoaded) {
      console.warn("⚠️ BM25Retriever.retrieve called before loadCorpus — returning []")
      return []
    }

    // BM25 search is synchronous; wrap in try/catch for safety
    let rawResults: ReturnType<BM25Index["search"]>
    try {
      rawResults = this.index.search(query, topK * 2) // over-fetch before filter
    } catch (err) {
      console.error(
        "❌ BM25Retriever: search failed —",
        err instanceof Error ? err.message : err
      )
      return []
    }

    // Apply metadata filter (simple equality checks on top-level metadata keys)
    const filtered =
      Object.keys(filter).length > 0
        ? rawResults.filter((doc) =>
            Object.entries(filter).every(([k, v]) => doc.metadata[k] === v)
          )
        : rawResults

    const sliced = filtered.slice(0, topK)
    if (sliced.length === 0) return []

    // Normalise scores to [0, 1]
    const rawScores = sliced.map((d) => d.score)
    const normScores = minMaxNormalise(rawScores)

    return sliced.map((doc, i): RetrievedContext => ({
      id: doc.id,
      content: doc.content,
      source: "bm25",
      confidenceScore: normScores[i],
      timestamp: parseTimestamp(
        doc.metadata.startTime ??
        doc.metadata.timestamp ??
        doc.metadata.meetingDate
      ),
      metadata: doc.metadata,
    }))
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton factory
// ---------------------------------------------------------------------------

let _instance: BM25Retriever | null = null

/**
 * Returns the shared BM25Retriever singleton.
 * Call `getBM25Retriever().loadCorpus(docs)` after fetching your corpus.
 */
export function getBM25Retriever(): BM25Retriever {
  if (!_instance) _instance = new BM25Retriever()
  return _instance
}
