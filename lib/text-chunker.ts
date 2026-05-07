/**
 * text-chunker.ts — Parent-Child Chunking (Phase 2)
 *
 * STRATEGY:
 *   Child chunks  ≈ 100 tokens  → embedded in Pinecone (precise retrieval)
 *   Parent chunks ≈ 500 tokens  → stored in DB (full context fed to LLM)
 *
 * Each child carries its parentContent inline so the RAG pipeline
 * never needs a second DB round-trip to "expand" context.
 * Siblings share a parentChunkId so parents can be reconstructed
 * from any child if needed.
 *
 * Old exports (chunkTranscript / extractSpeaker) are preserved
 * so nothing else in the codebase breaks.
 */

import { randomUUID } from "crypto"

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export type ChildChunk = {
  chunkIndex: number
  content: string           // small — goes to Pinecone
  parentContent: string     // large — stored in DB, fed to LLM
  parentChunkId: string     // groups siblings
  isChildChunk: true
}

export type LegacyChunk = {
  chunkIndex: number
  content: string
}

// ─────────────────────────────────────────────
// CONSTANTS  (tweak these to tune quality)
// ─────────────────────────────────────────────

const CHILD_SIZE  = 150   // chars  ≈ 100 tokens at ~1.5 chars/token
const PARENT_SIZE = 700   // chars  ≈ 500 tokens
const OVERLAP     = 30    // chars of overlap between child chunks

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

export function extractSpeaker(text: string): string | null {
  const match = text.match(/^([A-Za-z\s]+):\s*/)
  return match ? match[1].trim() : null
}

/**
 * Split raw transcript text into speaker-labeled lines,
 * filtering empties.
 */
function splitLines(transcript: string): string[] {
  return transcript.split("\n").filter(l => l.trim().length > 0)
}

// ─────────────────────────────────────────────
// LEGACY EXPORT  (used by processTranscript in old rag.ts)
// Keep this so the route handler doesn't break while we migrate.
// ─────────────────────────────────────────────

export function chunkTranscript(transcript: string): LegacyChunk[] {
  const maxChunkSize = 500
  const chunks: LegacyChunk[] = []
  const speakerLines = splitLines(transcript)

  let currentChunk = ""
  let chunkIndex   = 0

  for (const line of speakerLines) {
    if (currentChunk.length + line.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push({ content: currentChunk.trim(), chunkIndex })
      chunkIndex++
      currentChunk = line + "\n"
    } else {
      currentChunk += line + "\n"
    }
  }

  if (currentChunk.trim()) {
    chunks.push({ content: currentChunk.trim(), chunkIndex })
  }

  return chunks
}

// ─────────────────────────────────────────────
// NEW EXPORT: Parent-Child chunking
// ─────────────────────────────────────────────

/**
 * chunkTranscriptParentChild
 *
 * 1. Build PARENT windows (PARENT_SIZE chars) from the transcript lines.
 * 2. Slice each parent into smaller CHILD chunks (CHILD_SIZE chars, with OVERLAP).
 * 3. Each child carries the full parent text so the LLM always gets rich context.
 *
 * Usage in processTranscript:
 *   - Embed child.content → Pinecone
 *   - Store child.parentContent → TranscriptChunk.parentContent in NeonDB
 *   - child.parentChunkId groups siblings
 */
export function chunkTranscriptParentChild(transcript: string): ChildChunk[] {
  const lines = splitLines(transcript)
  const result: ChildChunk[] = []
  let chunkIndex = 0

  // ── Build parent windows ──────────────────────────────────
  const parents: string[] = []
  let currentParent = ""

  for (const line of lines) {
    if (currentParent.length + line.length > PARENT_SIZE && currentParent.length > 0) {
      parents.push(currentParent.trim())
      // Overlap: keep last line of this parent as first line of next
      const lastLine = currentParent.trimEnd().split("\n").at(-1) ?? ""
      currentParent = lastLine + "\n" + line + "\n"
    } else {
      currentParent += line + "\n"
    }
  }
  if (currentParent.trim()) parents.push(currentParent.trim())

  // ── Slice each parent into children ───────────────────────
  for (const parentContent of parents) {
    const parentChunkId = randomUUID()
    let pos = 0

    while (pos < parentContent.length) {
      const end = Math.min(pos + CHILD_SIZE, parentContent.length)
      const childContent = parentContent.slice(pos, end).trim()

      if (childContent.length > 0) {
        result.push({
          chunkIndex,
          content: childContent,          // → Pinecone
          parentContent,                  // → DB (expanded context)
          parentChunkId,
          isChildChunk: true,
        })
        chunkIndex++
      }

      // Advance by CHILD_SIZE - OVERLAP so adjacent children share context
      pos += CHILD_SIZE - OVERLAP
      if (pos >= parentContent.length) break
    }
  }

  return result
}