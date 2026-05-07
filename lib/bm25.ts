/**
 * BM25 — in-memory keyword search over transcript chunks
 * No npm package needed: pure TypeScript implementation.
 * Drop-in alongside Pinecone vector search in rag.ts
 */

export type BM25Document = {
  id: string
  content: string
  metadata: Record<string, unknown>
}

type BM25ScoredDoc = BM25Document & { score: number }

const K1 = 1.5  // term frequency saturation
const B  = 0.75 // length normalisation

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

export class BM25Index {
  private docs: BM25Document[] = []
  private tf: Map<string, Map<string, number>> = new Map()  // term → docId → tf
  private df: Map<string, number> = new Map()               // term → doc count
  private docLengths: Map<string, number> = new Map()
  private avgDocLength = 0

  build(docs: BM25Document[]) {
    this.docs = docs
    this.tf.clear()
    this.df.clear()
    this.docLengths.clear()

    let totalLength = 0

    for (const doc of docs) {
      const tokens = tokenize(doc.content)
      this.docLengths.set(doc.id, tokens.length)
      totalLength += tokens.length

      const termFreq = new Map<string, number>()
      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
      }

      for (const [term, freq] of termFreq) {
        this.tf.set(term, (this.tf.get(term) ?? new Map()).set(doc.id, freq))
        this.df.set(term, (this.df.get(term) ?? 0) + 1)
      }
    }

    this.avgDocLength = docs.length > 0 ? totalLength / docs.length : 1
    return this
  }

  search(query: string, topK = 10): BM25ScoredDoc[] {
    const queryTerms = tokenize(query)
    const N = this.docs.length
    const scores = new Map<string, number>()

    for (const term of queryTerms) {
      const df = this.df.get(term) ?? 0
      if (df === 0) continue

      // IDF — smoothed Robertson-Sparck Jones
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)
      const termDocs = this.tf.get(term) ?? new Map()

      for (const [docId, freq] of termDocs) {
        const dl  = this.docLengths.get(docId) ?? 1
        const norm = K1 * (1 - B + B * (dl / this.avgDocLength))
        const tfScore = (freq * (K1 + 1)) / (freq + norm)
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tfScore)
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => ({
        ...this.docs.find(d => d.id === id)!,
        score,
      }))
      .filter(d => d.content !== undefined)
  }
}