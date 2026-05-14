/**
 * lib/retrieval/context-compressor.ts
 *
 * Takes the merged output of Vector + Graph + BM25 retrievers and produces
 * a deduplicated, reranked, token-budget-aware list of RetrievedContext items
 * ready to be injected into the LLM prompt.
 *
 * Pipeline:
 *   1. Deduplicate — remove near-identical content blocks (Jaccard similarity).
 *   2. Rerank      — pass survivors through Cohere rerank (lib/reranker.ts).
 *   3. Token trim  — drop lowest-scoring items until total tokens ≤ maxTokens.
 *
 * The function is intentionally async-friendly and never throws; on any
 * failure it gracefully degrades to the scored input list.
 */

import { cohereRerank, type CandidateDoc } from "@/lib/reranker"
import { type RetrievedContext } from "./types"
import { scoreContext } from "./scoring"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity threshold above which two chunks are considered duplicates.
 * Higher = more aggressive deduplication.
 * Default 0.65 — keep content that shares < 65 % of trigrams with an already-kept item.
 */
export const DEDUP_JACCARD_THRESHOLD = 0.65

/**
 * Rough characters-per-token estimate (GPT-4 / Claude tokenisers).
 * Used for token budget estimation without requiring a real tokeniser dependency.
 */
const CHARS_PER_TOKEN = 4

// ---------------------------------------------------------------------------
// Deduplication via character trigram Jaccard similarity
// ---------------------------------------------------------------------------

function trigrams(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/\s+/g, " ").trim()
  const result = new Set<string>()
  for (let i = 0; i <= cleaned.length - 3; i++) {
    result.add(cleaned.slice(i, i + 3))
  }
  return result
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0

  let intersectionSize = 0
  for (const t of a) {
    if (b.has(t)) intersectionSize++
  }
  const unionSize = a.size + b.size - intersectionSize
  return intersectionSize / unionSize
}

/**
 * Remove duplicate or near-duplicate contexts.
 * Iterates in order (caller should pre-sort by score DESC so higher-quality
 * duplicates are kept over lower-quality ones).
 */
function deduplicate(
  contexts: RetrievedContext[],
  threshold: number = DEDUP_JACCARD_THRESHOLD
): RetrievedContext[] {
  const kept: RetrievedContext[] = []
  const keptTrigrams: Set<string>[] = []

  for (const ctx of contexts) {
    const ctxTrigrams = trigrams(ctx.content)

    const isDuplicate = keptTrigrams.some(
      (kt) => jaccardSimilarity(ctxTrigrams, kt) >= threshold
    )

    if (!isDuplicate) {
      kept.push(ctx)
      keptTrigrams.push(ctxTrigrams)
    }
  }

  return kept
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

// ---------------------------------------------------------------------------
// Reranker bridge
// ---------------------------------------------------------------------------

/**
 * Convert RetrievedContext → CandidateDoc (lib/reranker.ts interface).
 */
function toCandidateDoc(ctx: RetrievedContext, idx: number): CandidateDoc {
  return {
    id: ctx.id,
    content: ctx.content,
    metadata: ctx.metadata,
    score: ctx.confidenceScore,
    source: ctx.source === "vector" || ctx.source === "bm25" ? ctx.source : undefined,
  }
}

// ---------------------------------------------------------------------------
// Main compressor
// ---------------------------------------------------------------------------

/**
 * Compress a heterogeneous list of retrieved contexts into a clean, ranked,
 * token-budget-aware array.
 *
 * @param results    Merged output from Vector + Graph + BM25 retrievers.
 * @param query      The original user question (passed to Cohere rerank).
 * @param maxTokens  Maximum total token budget for all returned contexts combined.
 *                   Default 3 000 tokens.
 * @param topNRerank Number of candidates to request from Cohere rerank.
 *                   Should be ≥ the expected final list size.
 *
 * @returns          Deduplicated, reranked, token-trimmed RetrievedContext array
 *                   with `confidenceScore` updated to the Cohere relevance score.
 */
export async function compressRetrievals(
  results: RetrievedContext[],
  query: string,
  maxTokens: number = 3_000,
  topNRerank: number = 10
): Promise<RetrievedContext[]> {
  if (!results.length) return []
  if (!query?.trim()) {
    console.warn("⚠️ compressRetrievals: empty query — skipping rerank, returning scored+trimmed")
    return trimToTokenBudget(results, maxTokens)
  }

  // ── Step 1: Pre-sort by composite score (descending) before dedup ──────────
  const scored = results
    .map((ctx) => ({ ctx, score: scoreContext(ctx) }))
    .sort((a, b) => b.score - a.score)
    .map(({ ctx }) => ctx)

  // ── Step 2: Deduplicate ────────────────────────────────────────────────────
  const unique = deduplicate(scored)
  console.log(
    `🗜️  Compressor: ${results.length} → ${unique.length} after dedup (${results.length - unique.length} removed)`
  )

  // ── Step 3: Rerank via Cohere ──────────────────────────────────────────────
  let reranked: RetrievedContext[]
  try {
    const candidates = unique.map(toCandidateDoc)
    const rerankResults = await cohereRerank(query, candidates, topNRerank)

    // Map rerank output back to RetrievedContext, updating confidenceScore
    reranked = rerankResults.map((r): RetrievedContext => {
      // Find the original context by id
      const original = unique.find((ctx) => ctx.id === r.id)
      if (!original) {
        // Fallback: reconstruct from CandidateDoc fields
        return {
          id: r.id,
          content: r.content,
          source: (r.source as RetrievedContext["source"]) ?? "vector",
          confidenceScore: r.rerankScore,
          timestamp: null,
          metadata: r.metadata,
        }
      }
      return {
        ...original,
        confidenceScore: r.rerankScore,   // overwrite with Cohere's exact score
      }
    })

    console.log(`✅ Compressor: Cohere rerank returned ${reranked.length} results`)
  } catch (err) {
    console.error(
      "❌ Compressor: Cohere rerank failed — falling back to scored order:",
      err instanceof Error ? err.message : err
    )
    // Graceful fallback: use pre-scored unique list
    reranked = unique
  }

  // ── Step 4: Token budget trim ──────────────────────────────────────────────
  const trimmed = trimToTokenBudget(reranked, maxTokens)
  console.log(
    `🗜️  Compressor: ${reranked.length} → ${trimmed.length} after token trim (budget: ${maxTokens} tokens)`
  )

  return trimmed
}

// ---------------------------------------------------------------------------
// Token trim helper (also exported for standalone use)
// ---------------------------------------------------------------------------

/**
 * Drop the lowest-ranked items until the total estimated token count
 * of all remaining items is within `maxTokens`.
 *
 * Assumes the input is already sorted highest-relevance first.
 */
export function trimToTokenBudget(
  contexts: RetrievedContext[],
  maxTokens: number
): RetrievedContext[] {
  let tokenCount = 0
  const result: RetrievedContext[] = []

  for (const ctx of contexts) {
    const tokens = estimateTokens(ctx.content)
    if (tokenCount + tokens > maxTokens) {
      // Still add if this is the first item and it alone exceeds budget
      // (we always include at least one result to avoid returning nothing)
      if (result.length === 0) {
        result.push(ctx)
      }
      break
    }
    result.push(ctx)
    tokenCount += tokens
  }

  return result
}
