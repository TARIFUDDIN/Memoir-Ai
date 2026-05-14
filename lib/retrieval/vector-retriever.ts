/**
 * lib/retrieval/vector-retriever.ts
 *
 * Adapter that wraps lib/pinecone.ts `searchVectors` and normalises output
 * into RetrievedContext objects.
 *
 * Cosine similarity from Pinecone is already in [0, 1] for normalised vectors.
 * We forward it directly as `confidenceScore`.
 */

import { searchVectors } from "@/lib/pinecone"
import { type RetrievedContext, type Retriever, parseTimestamp } from "./types"

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

/**
 * Generate an embedding for the query using the same model that was used
 * at ingest time (text-embedding-3-small → 1536 dims).
 *
 * We call the OpenAI API directly here to keep the retriever self-contained.
 * If your project already exposes an `embed(text)` utility, swap this out.
 */
async function embedQuery(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set")

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI embeddings error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>
  }

  const embedding = data.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("OpenAI returned an empty embedding")
  }

  return embedding
}

// ---------------------------------------------------------------------------
// VectorRetriever
// ---------------------------------------------------------------------------

export class VectorRetriever implements Retriever {
  /**
   * @param defaultTopK  How many results to request from Pinecone by default.
   */
  constructor(private readonly defaultTopK: number = 10) {}

  async retrieve(
    query: string,
    topK: number = this.defaultTopK,
    filter: Record<string, unknown> = {}
  ): Promise<RetrievedContext[]> {
    if (!query?.trim()) return []

    let embedding: number[]
    try {
      embedding = await embedQuery(query)
    } catch (err) {
      console.error(
        "❌ VectorRetriever: embedding failed —",
        err instanceof Error ? err.message : err
      )
      return []
    }

    let matches: Awaited<ReturnType<typeof searchVectors>>
    try {
      matches = await searchVectors(embedding, filter, topK)
    } catch (err) {
      console.error(
        "❌ VectorRetriever: Pinecone query failed —",
        err instanceof Error ? err.message : err
      )
      return []
    }

    return matches
      .filter((m) => m.metadata && typeof m.metadata.text === "string")
      .map((m): RetrievedContext => {
        const meta = m.metadata as Record<string, unknown>

        // Pinecone score is cosine similarity ∈ [0, 1] for unit vectors.
        // Guard against rare out-of-range values.
        const rawScore = typeof m.score === "number" ? m.score : 0
        const confidenceScore = Math.max(0, Math.min(1, rawScore))

        return {
          id: m.id,
          content: String(meta.text ?? ""),
          source: "vector",
          confidenceScore,
          timestamp: parseTimestamp(meta.startTime ?? meta.timestamp ?? meta.meetingDate),
          metadata: meta,
        }
      })
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton factory
// ---------------------------------------------------------------------------

let _instance: VectorRetriever | null = null

export function getVectorRetriever(defaultTopK = 10): VectorRetriever {
  if (!_instance) _instance = new VectorRetriever(defaultTopK)
  return _instance
}
