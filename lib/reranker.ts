/**
 * Cohere Rerank v2 wrapper
 * Called AFTER merging BM25 + vector results.
 * Uses your existing COHERE_API_KEY env var.
 */

export type CandidateDoc = {
  id: string
  content: string
  metadata: Record<string, unknown>
  score?: number          // original BM25 or vector score
  source?: "vector" | "bm25" | "both"
}

export type RankedDoc = CandidateDoc & {
  rerankScore: number
  rerankIndex: number
}

export async function cohereRerank(
  query: string,
  candidates: CandidateDoc[],
  topN = 5
): Promise<RankedDoc[]> {
  if (candidates.length === 0) return []

  // Cohere rerank v2 — same API key you use for embeddings
  const response = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "rerank-english-v3.0",
      query,
      documents: candidates.map(c => c.content),
      top_n: topN,
      return_documents: false,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error("❌ Cohere rerank failed:", err)
    // Graceful fallback: return candidates sorted by original score
    return candidates
      .slice(0, topN)
      .map((c, i) => ({ ...c, rerankScore: c.score ?? 0, rerankIndex: i }))
  }

  const data = await response.json()
  const results = data.results as Array<{ index: number; relevance_score: number }>

  return results.map((r, i) => ({
    ...candidates[r.index],
    rerankScore: r.relevance_score,
    rerankIndex: i,
  }))
}