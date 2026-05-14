/**
 * lib/retrieval/scoring.ts
 *
 * Unified scoring for RetrievedContext objects from Vector, BM25, and Graph.
 *
 * Final score = sourceWeight(source) × semanticScore × temporalDecay(timestamp)
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Components
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * 1. sourceWeight
 *    Each retrieval backend has a tunable prior weight reflecting its typical
 *    precision for this application domain:
 *      vector → 1.00  (semantic similarity, broadest coverage)
 *      graph  → 0.95  (highly precise structural facts, narrower coverage)
 *      bm25   → 0.80  (keyword overlap, lower semantic depth)
 *
 * 2. semanticScore
 *    The `confidenceScore` [0, 1] emitted by the retriever adapter.
 *    Already normalised — no further transformation needed.
 *
 * 3. temporalDecay  — exponential decay on document age
 *    decay(t) = exp(-λ × ageDays / halfLifeDays)
 *
 *    Half-life is set to TEMPORAL_HALF_LIFE_DAYS (default 30 days), meaning
 *    a document exactly 30 days old retains 50 % of its temporal weight.
 *    λ = ln(2) so that decay(halfLife) = 0.5 exactly.
 *
 *    When timestamp is null (unknown age), a neutral factor of
 *    NULL_TIMESTAMP_FACTOR (0.70) is applied — penalising unknown-age content
 *    without discarding it entirely.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Tunables (export-accessible so callers can override for testing)
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { type RetrievedContext, type RetrievalSource } from "./types"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Temporal half-life in days. Documents this old retain 50 % of their time score. */
export const TEMPORAL_HALF_LIFE_DAYS = 30

/** Score factor applied when a document has no timestamp. */
export const NULL_TIMESTAMP_FACTOR = 0.70

/** λ = ln(2) — ensures decay(halfLife) = 0.5 exactly. */
const LAMBDA = Math.LN2

/** Per-source baseline weight multipliers. */
export const SOURCE_WEIGHTS: Record<RetrievalSource, number> = {
  vector: 1.00,
  graph:  0.95,
  bm25:   0.80,
}

// ---------------------------------------------------------------------------
// Temporal decay
// ---------------------------------------------------------------------------

/**
 * Compute the temporal decay factor for a given timestamp.
 * Returns a value in (0, 1].
 *
 * @param timestamp  Date of the source document, or null if unknown.
 * @param now        Reference "current" time (default: Date.now()).
 *                   Exposed as a parameter to make the function pure/testable.
 */
export function temporalDecay(
  timestamp: Date | null,
  now: Date = new Date()
): number {
  if (!timestamp) return NULL_TIMESTAMP_FACTOR

  const ageDays = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60 * 24)

  // Future-dated documents (clock skew, import artefacts) get score 1.0
  if (ageDays <= 0) return 1.0

  return Math.exp((-LAMBDA * ageDays) / TEMPORAL_HALF_LIFE_DAYS)
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * Compute a unified final score for a single RetrievedContext.
 *
 * The score is the product of:
 *   - source weight  (domain-tuned prior for each retrieval backend)
 *   - confidenceScore (semantic similarity / BM25 / structural confidence)
 *   - temporal decay  (exponential recency penalty)
 *
 * Result is clamped to [0, 1].
 *
 * @param context  The context to score.
 * @param now      Reference time for temporal decay (default: Date.now()).
 *                 Exposed for deterministic testing.
 */
export function scoreContext(
  context: RetrievedContext,
  now: Date = new Date()
): number {
  const weight  = SOURCE_WEIGHTS[context.source] ?? 1.0
  const semantic = Math.max(0, Math.min(1, context.confidenceScore))
  const decay   = temporalDecay(context.timestamp, now)

  const score = weight * semantic * decay
  return Math.max(0, Math.min(1, score))
}

// ---------------------------------------------------------------------------
// Batch helper
// ---------------------------------------------------------------------------

/**
 * Score every context in an array and return them sorted descending by score.
 * This is a pure convenience wrapper — callers can also call scoreContext
 * individually.
 */
export function scoreAndSort(
  contexts: RetrievedContext[],
  now: Date = new Date()
): Array<RetrievedContext & { finalScore: number }> {
  return contexts
    .map((ctx) => ({ ...ctx, finalScore: scoreContext(ctx, now) }))
    .sort((a, b) => b.finalScore - a.finalScore)
}
