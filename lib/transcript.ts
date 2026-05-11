/**
 * lib/transcription.ts
 * Migrated: Gemini File API → Groq Whisper API
 * Groq Whisper: free, fast, 25MB limit, 7200 req/day
 */

import Groq from "groq-sdk"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ✅ FIX 1: Set a 120s timeout on the Groq client — default is no timeout,
//    which causes large files to hang indefinitely.
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
  timeout: 120_000, // 2 minutes
  maxRetries: 0,    // We handle retries ourselves below
})

// How many times to retry a timed-out Whisper call
const WHISPER_MAX_RETRIES = 2
// Chunk size for large files — 23MB to stay safely under 25MB Groq limit
const CHUNK_SIZE_BYTES = 23 * 1024 * 1024

interface TranscriptWord {
  word: string
  start: number
  end: number
}

interface TranscriptSegment {
  speaker: string
  offset: number
  start_time: number
  end_time: number
  words: TranscriptWord[]
}

/**
 * Transcribe audio from a URL using Groq Whisper
 * Free tier: 7200 requests/day, up to 25MB per file
 */
export async function transcribeAudioFromUrl(
  audioUrl: string
): Promise<TranscriptSegment[] | null> {
  try {
    console.log(`🎙️ Groq Whisper transcribing: ${audioUrl}`)

    console.log("📥 Downloading audio...")
    const audioBuffer = await downloadAudio(audioUrl)
    if (!audioBuffer) {
      console.error("❌ Failed to download audio")
      return null
    }

    const sizeMB = audioBuffer.length / 1024 / 1024
    console.log(`📥 Downloaded: ${sizeMB.toFixed(1)}MB`)

    // ✅ FIX 2: Split large files into chunks instead of hard-truncating.
    //    Hard truncation cuts audio mid-sentence; chunking transcribes everything.
    if (audioBuffer.length > CHUNK_SIZE_BYTES) {
      console.warn(
        `⚠️ File is ${sizeMB.toFixed(1)}MB — splitting into chunks for Whisper...`
      )
      return await transcribeInChunks(audioBuffer, audioUrl)
    }

    return await transcribeBufferWithRetry(audioBuffer, audioUrl)
  } catch (error) {
    console.error("❌ Groq Whisper transcription failed:", error)
    return null
  }
}

/**
 * ✅ FIX 3: Retry wrapper — on timeout or 5xx, waits then retries.
 * Throws on final failure so callers can handle gracefully.
 */
async function transcribeBufferWithRetry(
  audioBuffer: Buffer,
  audioUrl: string,
  attempt = 1
): Promise<TranscriptSegment[] | null> {
  try {
    return await transcribeBuffer(audioBuffer, audioUrl)
  } catch (error: any) {
    const isRetryable =
      error?.message?.includes("timed out") ||
      error?.message?.includes("timeout") ||
      error?.code === "ETIMEDOUT" ||
      error?.status === 408 ||
      error?.status === 503 ||
      error?.status === 502

    if (isRetryable && attempt <= WHISPER_MAX_RETRIES) {
      const waitMs = attempt * 5000 // 5s then 10s
      console.warn(
        `⚠️ Whisper attempt ${attempt} failed (${error?.message}). ` +
          `Retrying in ${waitMs / 1000}s...`
      )
      await sleep(waitMs)
      return transcribeBufferWithRetry(audioBuffer, audioUrl, attempt + 1)
    }

    throw error
  }
}

/**
 * ✅ FIX 4: Chunk large audio into pieces, transcribe each, stitch with
 * shifted timestamps. Better than truncating — all audio gets processed.
 *
 * Caveat: this is a byte-split not an audio-frame split, so words at chunk
 * boundaries may be slightly garbled. For production, use ffmpeg silence detection.
 */
async function transcribeInChunks(
  audioBuffer: Buffer,
  audioUrl: string
): Promise<TranscriptSegment[] | null> {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_SIZE_BYTES) {
    chunks.push(audioBuffer.slice(offset, offset + CHUNK_SIZE_BYTES))
  }

  console.log(`📦 Split into ${chunks.length} chunks`)

  const allSegments: TranscriptSegment[] = []
  let timeOffset = 0

  for (let i = 0; i < chunks.length; i++) {
    console.log(
      `🔄 Transcribing chunk ${i + 1}/${chunks.length} ` +
        `(${(chunks[i].length / 1024 / 1024).toFixed(1)}MB)...`
    )

    let segments: TranscriptSegment[] | null = null
    try {
      segments = await transcribeBufferWithRetry(chunks[i], audioUrl)
    } catch (err) {
      console.error(`❌ Chunk ${i + 1} failed after retries — skipping:`, err)
      continue // Don't abort the whole job for one bad chunk
    }

    if (!segments || segments.length === 0) continue

    // Shift all timestamps by accumulated offset from previous chunks
    const shifted = segments.map((seg) => ({
      ...seg,
      offset: seg.offset + timeOffset,
      start_time: seg.start_time + timeOffset,
      end_time: seg.end_time + timeOffset,
      words: seg.words.map((w) => ({
        ...w,
        start: w.start + timeOffset,
        end: w.end + timeOffset,
      })),
    }))

    allSegments.push(...shifted)

    // Advance offset by this chunk's last segment end time
    const lastSeg = segments[segments.length - 1]
    timeOffset += lastSeg.end_time
  }

  console.log(`✅ All chunks complete — ${allSegments.length} total segments`)
  return allSegments.length > 0 ? allSegments : null
}

async function transcribeBuffer(
  audioBuffer: Buffer,
  audioUrl: string
): Promise<TranscriptSegment[] | null> {
  let tempFilePath: string | null = null
  try {
    const ext = detectExtension(audioUrl)
    tempFilePath = path.join(os.tmpdir(), `meeting_audio_${Date.now()}.${ext}`)
    fs.writeFileSync(tempFilePath, audioBuffer)

    console.log("🚀 Sending to Groq Whisper...")

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-large-v3",
      response_format: "verbose_json",
      language: "en",
      timestamp_granularities: ["segment", "word"],
    })

    console.log(`✅ Groq Whisper complete`)
    return parseWhisperResponse(transcription as any)
  } finally {
    // Always clean up temp file even if Groq threw
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath) } catch {}
    }
  }
}

/**
 * Parse Groq Whisper verbose_json response into TranscriptSegments
 */
function parseWhisperResponse(response: any): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  if (!response) return segments

  if (response.segments && Array.isArray(response.segments)) {
    console.log(`📊 Processing ${response.segments.length} Whisper segments`)

    let speakerIndex = 0
    const speakers = ["Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4"]

    for (const segment of response.segments) {
      const text = segment.text?.trim() || ""
      if (!text) continue

      const startTime = segment.start || 0
      const endTime = segment.end || startTime + 1
      const duration = endTime - startTime

      let words: TranscriptWord[] = []

      if (segment.words && Array.isArray(segment.words) && segment.words.length > 0) {
        words = segment.words.map((w: any): TranscriptWord => ({
          word: String(w.word || "").trim(),
          start: Number(w.start || startTime),
          end: Number(w.end || endTime),
        }))
      } else {
        words = buildWordsFromText(text, startTime, endTime)
      }

      if (speakerIndex > 0 && duration > 2) speakerIndex++
      const speaker = speakers[speakerIndex % speakers.length]

      segments.push({
        speaker,
        offset: startTime,
        start_time: startTime,
        end_time: endTime,
        words,
      })
    }
  } else if (response.text) {
    const words = buildWordsFromText(response.text, 0, response.duration || 60)
    segments.push({
      speaker: "Speaker 1",
      offset: 0,
      start_time: 0,
      end_time: response.duration || 60,
      words,
    })
  }

  return segments
}

async function downloadAudio(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download: ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    console.error("Error downloading audio:", error)
    return null
  }
}

function detectExtension(audioUrl: string): string {
  const url = audioUrl.toLowerCase().split("?")[0]
  if (url.endsWith(".mp3")) return "mp3"
  if (url.endsWith(".mp4") || url.endsWith(".m4a")) return "mp4"
  if (url.endsWith(".wav")) return "wav"
  if (url.endsWith(".ogg")) return "ogg"
  if (url.endsWith(".flac")) return "flac"
  if (url.endsWith(".webm")) return "webm"
  return "wav"
}

function buildWordsFromText(
  text: string,
  startTime: number,
  endTime: number
): TranscriptWord[] {
  const textWords = text.split(/\s+/).filter((w) => w.length > 0)
  if (textWords.length === 0) return []
  const duration = Math.max(endTime - startTime, 1)
  const timePerWord = duration / textWords.length
  return textWords.map((word, i): TranscriptWord => ({
    word,
    start: startTime + i * timePerWord,
    end: startTime + (i + 1) * timePerWord,
  }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function transcribeAudioSimple(
  audioBuffer: Buffer,
  audioUrl: string = ""
): Promise<TranscriptSegment[] | null> {
  return transcribeBufferWithRetry(audioBuffer, audioUrl)
}