import { NextRequest, NextResponse } from "next/server"
import { PrismaClient } from "@prisma/client"
import { Client } from "@upstash/qstash"
import { normalizeTranscript, validateTranscript } from "@/lib/transcript-parser"
import { transcribeAudioFromUrl } from "@/lib/transcript"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The set of task types that each independent QStash job can handle.
 * Keep this in sync with the `taskType` switch in process-meeting/route.ts.
 */
export type MeetingTaskType = "SUMMARY" | "RISK" | "SENTIMENT" | "PROFILES" | "GRAPH"

const ALL_TASK_TYPES: MeetingTaskType[] = [ "SUMMARY", "RISK", "SENTIMENT", "PROFILES", "GRAPH" ]

// ─── Clients ──────────────────────────────────────────────────────────────────

// ✅ Add connection pool settings so Supabase doesn't drop idle connections.
//    The Whisper call can take 60-120 s — without pool_timeout the connection
//    times out while we wait, then the subsequent .update() fails.
const webhookPrisma = new PrismaClient( {
  datasourceUrl: process.env.DATABASE_URL,
  log: [ "error" ],
} )

const qstash = new Client( { token: process.env.QSTASH_TOKEN! } )

// ─── Deduplication ────────────────────────────────────────────────────────────

const processedBots = new Set<string>()

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST ( request: NextRequest )
{
  try
  {
    const bodyText = await request.text()
    const webhook = JSON.parse( bodyText )
    const webhookData = webhook.data || {}
    const botId = webhookData.bot_id || webhook.bot_id

    const isCompletionEvent =
      webhook.event === "complete" ||
      webhook.event === "meeting.ended" ||
      webhook.event === "bot_data" ||
      webhookData.transcript ||
      webhookData.audio ||
      webhookData.mp4

    if ( !botId || !isCompletionEvent )
    {
      return NextResponse.json( { success: true, ignored: true } )
    }

    if ( processedBots.has( botId ) )
    {
      console.log( `⚠️ Duplicate webhook for bot ${ botId } — ignoring` )
      return NextResponse.json( { success: true, deduplicated: true } )
    }

    processedBots.add( botId )
    setTimeout( () => processedBots.delete( botId ), 5 * 60 * 1000 )

    // Fire-and-forget — the webhook must return quickly
    processWebhook( botId, webhookData ).catch( ( err ) =>
      console.error( "❌ Background processing failed:", err )
    )

    return NextResponse.json( { success: true, message: "Processing started" } )
  } catch ( error )
  {
    console.error( "Webhook error:", error )
    return NextResponse.json( { success: true } )
  }
}

// ─── Background processing ───────────────────────────────────────────────────

async function processWebhook ( botId: string, webhookData: any )
{
  // ✅ Single try/finally — ONE connect at the start, ONE disconnect at the end.
  try
  {
    console.log( `🔔 Processing data for Bot ID: ${ botId }` )

    const meeting = await webhookPrisma.meeting.findFirst( {
      where: { botId },
      include: { createdBy: true },
    } )

    if ( !meeting )
    {
      console.error( "❌ Meeting not found for bot id:", botId )
      return
    }

    let parsedTranscript: any = meeting.transcript

    const transcriptHasContent =
      webhookData.transcript &&
      Array.isArray( webhookData.transcript ) &&
      webhookData.transcript.some( ( seg: any ) => seg.words && seg.words.length > 0 )

    if ( ( !webhookData.transcript || !transcriptHasContent ) && webhookData.audio )
    {
      console.log( `🎙️ No transcript content — transcribing audio with Groq Whisper...` )
      try
      {
        const transcribedSegments = await transcribeAudioFromUrl( webhookData.audio )
        if ( transcribedSegments && transcribedSegments.length > 0 )
        {
          if (
            webhookData.transcript &&
            Array.isArray( webhookData.transcript ) &&
            webhookData.transcript.length > 0
          )
          {
            const merged = mergeTranscriptWithSpeakers(
              webhookData.transcript,
              transcribedSegments
            )
            parsedTranscript = merged.length > 0 ? merged : transcribedSegments
          } else
          {
            parsedTranscript = transcribedSegments
          }
          console.log( `✅ Audio transcribed: ${ transcribedSegments.length } segments` )
        } else
        {
          console.warn( "⚠️ Whisper returned no segments — storing null transcript" )
          parsedTranscript = null
        }
      } catch ( err )
      {
        console.error( "❌ Transcription failed:", err )
        parsedTranscript = meeting.transcript ?? null
      }
    } else if ( webhookData.transcript && transcriptHasContent )
    {
      try
      {
        let rawTranscript = webhookData.transcript
        if ( typeof webhookData.transcript === "string" )
        {
          rawTranscript = JSON.parse( webhookData.transcript )
        }
        const normalized = normalizeTranscript( rawTranscript )
        if ( normalized && validateTranscript( normalized ) )
        {
          parsedTranscript = normalized
          console.log( `✅ Transcript normalized: ${ normalized.length } segments` )
        } else
        {
          parsedTranscript = rawTranscript
        }
      } catch
      {
        parsedTranscript = webhookData.transcript
      }
    }

    console.log(
      "📝 Transcript type:",
      typeof parsedTranscript,
      "Is null:",
      parsedTranscript === null
    )

    // Always update the meeting — even when parsedTranscript is null — so
    // meetingEnded is never left as false.
    await webhookPrisma.meeting.update( {
      where: { id: meeting.id },
      data: {
        meetingEnded: true,
        transcriptReady: parsedTranscript !== null,
        transcript: parsedTranscript,
        recordingUrl: webhookData.mp4 || meeting.recordingUrl,
        speakers: webhookData.speakers || meeting.speakers,
      },
    } )

    if ( !parsedTranscript )
    {
      console.warn(
        `⚠️ No transcript for meeting ${ meeting.id } — skipping queue. ` +
        `Meeting marked ended but transcriptReady=false.`
      )
      return
    }

    const updatedMeeting = await webhookPrisma.meeting.findUnique( {
      where: { id: meeting.id },
    } )

    if ( !updatedMeeting?.transcript )
    {
      console.log( `⏳ Transcript not ready for meeting ${ meeting.id }` )
      return
    }

    const transcriptBytes = JSON.stringify( updatedMeeting.transcript ).length
    console.log( `📝 Transcript ready (${ transcriptBytes } bytes). Fanning out ${ ALL_TASK_TYPES.length } jobs...` )

    // ── Fan-out: one independent QStash job per task type ──────────────────
    //
    // Benefits vs a monolithic job:
    //   • Each task gets its own serverless timeout window.
    //   • A failure in SENTIMENT doesn't re-run (and re-bill) SUMMARY.
    //   • QStash retries only the failed task.
    //   • retries: 3 + exponential backoff handles Groq rate limits gracefully.
    //
    const appUrl = process.env.NEXT_PUBLIC_APP_URI
    const workerUrl = `${ appUrl }/api/queue/process-meeting`

    const basePayload = {
      meetingId: meeting.id,
      transcript: updatedMeeting.transcript,
      botId,
      meetingTitle: meeting.title,
    }

    const publishResults = await Promise.allSettled(
      ALL_TASK_TYPES.map( ( taskType ) =>
        qstash.publishJSON( {
          url: workerUrl,
          body: { ...basePayload, taskType },
          // Retry with exponential backoff — critical for Groq free-tier rate limits.
          // QStash default schedule: 1st retry after 1 min, 2nd after 5 min, 3rd after 20 min.
          retries: 3,
          // Spread the initial fan-out by taskType index to avoid hammering Groq
          // with all 5 tasks at exactly the same second.
          delay: ALL_TASK_TYPES.indexOf( taskType ) * 2, // seconds
        } )
      )
    )

    publishResults.forEach( ( result, i ) =>
    {
      if ( result.status === "fulfilled" )
      {
        console.log( `📨 Queued [${ ALL_TASK_TYPES[ i ] }] msgId=${ result.value.messageId }` )
      } else
      {
        console.error( `❌ Failed to queue [${ ALL_TASK_TYPES[ i ] }]:`, result.reason )
      }
    } )
  } finally
  {
    // ✅ Single disconnect point — always runs, even on error.
    await webhookPrisma.$disconnect()
  }
}

// ─── Transcript merge helper ─────────────────────────────────────────────────

function mergeTranscriptWithSpeakers (
  originalSegments: any[],
  transcribedSegments: any[]
): any[]
{
  if ( !transcribedSegments || transcribedSegments.length === 0 ) return originalSegments

  const fullText = transcribedSegments
    .map( ( seg: any ) => seg.words?.map( ( w: any ) => w.word ).join( " " ) || "" )
    .join( " " )
    .trim()

  if ( !fullText ) return originalSegments

  const words = fullText.split( /\s+/ ).filter( ( w: string ) => w.length > 0 )

  const validSegments = originalSegments.filter( ( seg: any ) =>
  {
    const startTime = seg.start_time || seg.offset || 0
    const endTime = seg.end_time || startTime + 1
    return endTime - startTime > 0.1
  } )

  const totalDuration = validSegments.reduce( ( sum: number, seg: any ) =>
  {
    const startTime = seg.start_time || seg.offset || 0
    const endTime = seg.end_time || startTime + 1
    return sum + ( endTime - startTime )
  }, 0 )

  let wordIndex = 0
  const merged: any[] = []

  for ( const originalSeg of validSegments )
  {
    const speaker = originalSeg.speaker || "Unknown"
    const offset = originalSeg.offset || originalSeg.start_time || 0
    const startTime = originalSeg.start_time || offset
    const endTime = originalSeg.end_time || startTime + 1
    const duration = endTime - startTime

    const proportion = duration / totalDuration
    const estimatedWords = Math.max( 1, Math.round( proportion * words.length ) )
    const segmentTextWords = words.slice( wordIndex, wordIndex + estimatedWords )
    const segmentWords: any[] = []

    if ( segmentTextWords.length > 0 )
    {
      const timePerWord = duration / Math.max( 1, segmentTextWords.length )
      let currentTime = startTime
      for ( const word of segmentTextWords )
      {
        segmentWords.push( { word, start: currentTime, end: currentTime + timePerWord } )
        currentTime += timePerWord
      }
      wordIndex += estimatedWords
    }

    merged.push( {
      speaker,
      offset,
      start_time: startTime,
      end_time: endTime,
      words: segmentWords,
    } )
  }

  if ( wordIndex < words.length && merged.length > 0 )
  {
    const remaining = words.slice( wordIndex )
    const lastSeg = merged[ merged.length - 1 ]
    const lastWordEnd =
      lastSeg.words?.[ lastSeg.words.length - 1 ]?.end || lastSeg.end_time
    remaining.forEach( ( word, i ) =>
    {
      lastSeg.words.push( {
        word,
        start: lastWordEnd + i * 0.3,
        end: lastWordEnd + ( i + 1 ) * 0.3,
      } )
    } )
  }

  console.log(
    `✅ Merged ${ merged.length } segments (filtered from ${ originalSegments.length })`
  )
  return merged
}