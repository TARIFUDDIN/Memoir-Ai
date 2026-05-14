/**
 * SENTIMENT AGENT
 * Phase 3.2 — Multi-Agent Orchestration
 *
 * Responsibilities:
 *  - Slice the transcript into 30-second windows
 *  - Score each speaker's sentiment per window (-1.0 → +1.0)
 *  - Batch windows into groups of 5 to keep Groq payloads small
 *  - Persist the resulting arc to Meeting.sentimentData
 *
 * Caching: the full arc is cached by the derived windows payload (not the raw
 * transcript) so the cache key is stable even if the transcript object
 * reference changes between QStash retries.
 */

import { prisma } from "@/lib/db"
import {
  BaseAgent,
  AgentRunOptions,
  getCachedOrGenerate,
  groq,
  MODEL,
} from "./base-agent"
import { parseAgentJSON } from "./base-agent"

// ─── Types ────────────────────────────────────────────────────────────────────

export type SentimentDataPoint = {
  timestamp: number
  [ speakerName: string ]: number | undefined
}

type SentimentWindow = {
  timestamp: number
  text: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5
const WINDOW_SIZE_SECONDS = 30
const TEMPERATURE = 0.2
const MAX_TOKENS = 600

// ─── Agent ────────────────────────────────────────────────────────────────────

export class SentimentAgent extends BaseAgent<SentimentDataPoint[]>
{
  readonly taskName = "sentiment_arc"

  protected async execute ( { meetingId, transcript }: AgentRunOptions ): Promise<SentimentDataPoint[]>
  {
    // Sentiment requires the structured array format (needs timestamps).
    if ( !Array.isArray( transcript ) )
    {
      throw new Error( "SENTIMENT_REQUIRES_ARRAY_TRANSCRIPT" )
    }

    const duration = estimateMeetingDuration( transcript )
    if ( duration === 0 ) throw new Error( "SENTIMENT_CANNOT_DETERMINE_DURATION" )

    const windows = createSentimentWindows( transcript, duration, WINDOW_SIZE_SECONDS )
    if ( windows.length === 0 ) throw new Error( "SENTIMENT_NO_WINDOWS_CREATED" )

    // Cache key uses the derived windows payload for stability across retries.
    const sentimentData = await getCachedOrGenerate<SentimentDataPoint[]>(
      "sentiment_arc",
      windows,
      () => processSentimentBatches( windows, BATCH_SIZE )
    )

    if ( sentimentData.length === 0 )
    {
      throw new Error( "SENTIMENT_EMPTY_RESULT" )
    }

    // Persist — must succeed before idempotency key is written.
    await prisma.meeting.update( {
      where: { id: meetingId },
      // Prisma accepts any JSON-serialisable value for Json fields.
      data: { sentimentData: sentimentData as any },
    } )

    return sentimentData
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estimateMeetingDuration ( transcript: unknown[] ): number
{
  let maxDuration = 0
  for ( const segment of transcript )
  {
    const seg = segment as Record<string, unknown>
    let segEnd = 0
    if ( Array.isArray( seg.words ) && seg.words.length > 0 )
    {
      const lastWord = seg.words[ seg.words.length - 1 ] as Record<string, unknown>
      segEnd = ( lastWord?.end as number ) ?? 0
    } else if ( typeof seg.end_time === "number" )
    {
      segEnd = seg.end_time
    } else if ( typeof seg.end === "number" )
    {
      segEnd = seg.end
    }
    maxDuration = Math.max( maxDuration, segEnd )
  }
  return maxDuration
}

function createSentimentWindows (
  transcript: unknown[],
  duration: number,
  windowSize: number
): SentimentWindow[]
{
  const windows: SentimentWindow[] = []

  for ( let t = 0; t < duration; t += windowSize )
  {
    const windowEnd = t + windowSize
    const segmentsInWindow = transcript.filter( ( item ) =>
    {
      const seg = item as Record<string, unknown>
      let segStart = 0
      if ( Array.isArray( seg.words ) && seg.words.length > 0 )
      {
        const firstWord = seg.words[ 0 ] as Record<string, unknown>
        segStart = ( firstWord?.start as number ) ?? 0
      } else if ( typeof seg.offset === "number" )
      {
        segStart = seg.offset
      } else if ( typeof seg.start_time === "number" )
      {
        segStart = seg.start_time
      }
      return segStart >= t && segStart < windowEnd
    } )

    if ( segmentsInWindow.length === 0 ) continue

    const textPayload = segmentsInWindow
      .map( ( s ) =>
      {
        const seg = s as Record<string, unknown>
        const text =
          Array.isArray( seg.words ) && seg.words.length > 0
            ? ( seg.words as unknown[] )
              .map( ( w ) => String( ( w as Record<string, unknown> ).word ?? "" ) )
              .join( " " )
            : String( seg.text ?? "" )
        return text
          ? `${ String( seg.speaker ) }: ${ text }`
          : `${ String( seg.speaker ) }: [speaking]`
      } )
      .join( "\n" )

    windows.push( { timestamp: t, text: textPayload } )
  }

  return windows
}

async function processSentimentBatches (
  windows: SentimentWindow[],
  batchSize: number
): Promise<SentimentDataPoint[]>
{
  const sentimentData: SentimentDataPoint[] = []

  for ( let i = 0; i < windows.length; i += batchSize )
  {
    const batch = windows.slice( i, i + batchSize )
    try
    {
      const response = await groq.chat.completions.create( {
        model: MODEL,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Analyse sentiment per speaker per timestamp.
Scores: -1.0 = Negative, 0.0 = Neutral, 1.0 = Positive.
Return JSON keyed by timestamp (as string): { "60": { "Alice": -0.8, "Bob": 0.5 } }
Include every timestamp from the input even if speakers are silent (use 0.0).`,
          },
          { role: "user", content: JSON.stringify( batch ) },
        ],
      } )

      const batchResults = parseAgentJSON<Record<string, Record<string, number>>>(
        response.choices[ 0 ]?.message?.content
      )

      batch.forEach( ( window ) =>
      {
        const scores = batchResults[ String( window.timestamp ) ] ?? {}
        sentimentData.push( { timestamp: window.timestamp, ...scores } )
      } )
    } catch ( err )
    {
      console.error( `⚠️  Sentiment batch ${ i }–${ i + batchSize } failed:`, err )
      // Don't throw — partial failure produces a degraded but usable arc.
      batch.forEach( ( w ) => sentimentData.push( { timestamp: w.timestamp } ) )
    }
  }

  return sentimentData
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const sentimentAgent = new SentimentAgent()
