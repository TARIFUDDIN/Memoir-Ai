/**
 * lib/compressor.ts — Context Compression (Phase 2)
 *
 * After retrieval, before the LLM call:
 *   1. Each retrieved chunk is passed to a small fast Groq call.
 *   2. Groq extracts ONLY the sentences relevant to the user's question.
 *   3. Irrelevant filler is dropped → fewer tokens → lower cost, better answers.
 *
 * Falls back to the original chunk if compression fails or returns empty.
 *
 * Uses llama-3.1-8b-instant (fastest/cheapest Groq model) — not the 70b.
 * Runs all chunks in parallel so latency is bounded by the slowest chunk,
 * not the sum of all chunks.
 */

import Groq from "groq-sdk"

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })

// Use the small fast model — compression doesn't need reasoning power
const COMPRESSION_MODEL = "llama-3.1-8b-instant"

// Don't compress chunks shorter than this — nothing to compress
const MIN_COMPRESS_LENGTH = 200

export type CompressedChunk = {
  originalContent: string
  compressedContent: string
  wasCompressed: boolean
  compressionRatio: number   // 0-1, lower = more compressed
}

/**
 * Compress a single chunk — extract only sentences relevant to the question.
 */
async function compressChunk(
  chunk: string,
  question: string
): Promise<string> {
  // Skip tiny chunks
  if (chunk.length < MIN_COMPRESS_LENGTH) return chunk

  try {
    const response = await groq.chat.completions.create({
      model: COMPRESSION_MODEL,
      temperature: 0,          // deterministic extraction
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `You are a context extractor. Given a meeting transcript excerpt and a question,
extract ONLY the sentences from the excerpt that are directly relevant to answering the question.

Rules:
- Copy relevant sentences verbatim — do not paraphrase or summarize
- Preserve speaker labels (e.g. "Alice: ...")
- If NO sentences are relevant, reply with exactly: IRRELEVANT
- Output only the extracted sentences, nothing else`,
        },
        {
          role: "user",
          content: `QUESTION: ${question}

EXCERPT:
${chunk}`,
        },
      ],
    })

    const compressed = response.choices[0]?.message?.content?.trim() ?? ""

    // If model says nothing relevant, return empty string (caller handles fallback)
    if (compressed === "IRRELEVANT" || compressed.length === 0) return ""

    return compressed
  } catch (err) {
    console.warn("⚠️ Compression failed for chunk, using original:", err)
    return chunk
  }
}

/**
 * compressChunks
 *
 * Takes an array of retrieved doc contents + the user question.
 * Returns compressed versions — or originals if compression would make things worse.
 *
 * @param chunks   Array of { id, content, metadata } objects
 * @param question The user's question
 */
export async function compressChunks<T extends { id: string; content: string }>(
  chunks: T[],
  question: string
): Promise<(T & CompressedChunk)[]> {
  if (chunks.length === 0) return []

  // Run all compressions in parallel
  const compressions = await Promise.all(
    chunks.map(chunk => compressChunk(chunk.content, question))
  )

  return chunks.map((chunk, i) => {
    const compressed = compressions[i] ?? ""

    // Fallback: if empty or longer than original, keep original
    const useCompressed =
      compressed.length > 0 && compressed.length < chunk.content.length

    const finalContent = useCompressed ? compressed : chunk.content

    return {
      ...chunk,
      content: finalContent,             // overwrite content in place
      originalContent: chunk.content,
      compressedContent: compressed,
      wasCompressed: useCompressed,
      compressionRatio: useCompressed
        ? compressed.length / chunk.content.length
        : 1,
    }
  })
}