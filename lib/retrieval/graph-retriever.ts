/**
 * lib/retrieval/graph-retriever.ts
 *
 * Adapter that wraps `queryGraphMemory` from lib/graph.ts and normalises its
 * free-text output into a single RetrievedContext object.
 *
 * Graph results are structural / relational answers rather than scored chunks,
 * so we assign a fixed structural confidence score (tunable) and attempt to
 * extract a timestamp from the response text or fall back to null.
 *
 * Design note: graph retrieval returns ONE synthesized answer string per query,
 * not multiple chunks. We therefore produce exactly 0–1 RetrievedContext items.
 */

import { queryGraphMemory } from "@/lib/graph"
import { type RetrievedContext, type Retriever } from "./types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Baseline confidence for graph results.
 * Graph answers are highly precise when they exist, so we default to 0.80.
 * Callers can override via GraphRetriever constructor.
 */
const DEFAULT_GRAPH_CONFIDENCE = 0.80

/**
 * Simple ISO date pattern used to try extracting a timestamp from the
 * graph answer text (e.g. "2024-03-15" appearing in meeting titles).
 */
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract the most recent ISO date string from free-form graph text.
 * Returns a Date if found, null otherwise.
 */
function extractDateFromText(text: string): Date | null {
  const matches = [...text.matchAll(new RegExp(ISO_DATE_RE, "g"))]
  if (!matches.length) return null

  // Take the most recent date mentioned
  const dates = matches
    .map((m) => new Date(m[1]))
    .filter((d) => !isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())

  return dates[0] ?? null
}

/**
 * Determine whether the graph returned a meaningful answer
 * vs. a "no results" message.
 */
function isEmptyAnswer(answer: string): boolean {
  const lower = answer.toLowerCase().trim()
  return (
    lower === "" ||
    lower.startsWith("no information") ||
    lower.startsWith("no meetings found") ||
    lower.startsWith("no action items") ||
    lower.startsWith("could not identify") ||
    lower.startsWith("error:")
  )
}

// ---------------------------------------------------------------------------
// GraphRetriever
// ---------------------------------------------------------------------------

export class GraphRetriever implements Retriever {
  /**
   * @param baseConfidence  Confidence score assigned to non-empty graph answers.
   *                        Defaults to 0.80 — override if your scoring calibration differs.
   */
  constructor(private readonly baseConfidence: number = DEFAULT_GRAPH_CONFIDENCE) {}

  async retrieve(
    query: string,
    _topK?: number,              // Graph returns one synthesized answer; topK is unused
    _filter?: Record<string, unknown>
  ): Promise<RetrievedContext[]> {
    if (!query?.trim()) return []

    let answer: string
    try {
      answer = await queryGraphMemory(query)
    } catch (err) {
      console.error(
        "❌ GraphRetriever: queryGraphMemory failed —",
        err instanceof Error ? err.message : err
      )
      return []
    }

    if (!answer || isEmptyAnswer(answer)) return []

    const timestamp = extractDateFromText(answer)

    return [
      {
        id: `graph:${Date.now()}:${Buffer.from(query).toString("base64").slice(0, 12)}`,
        content: answer,
        source: "graph",
        confidenceScore: this.baseConfidence,
        timestamp,
        metadata: {
          query,
          retrievedAt: new Date().toISOString(),
        },
      },
    ]
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton factory
// ---------------------------------------------------------------------------

let _instance: GraphRetriever | null = null

export function getGraphRetriever(baseConfidence = DEFAULT_GRAPH_CONFIDENCE): GraphRetriever {
  if (!_instance) _instance = new GraphRetriever(baseConfidence)
  return _instance
}
