import { NextRequest, NextResponse } from "next/server"
import { PrismaClient } from "@prisma/client"
import { Client } from "@upstash/qstash"
import { normalizeTranscript, validateTranscript } from "@/lib/transcript-parser"
import { transcribeAudioFromUrl } from "@/lib/transcript"

// ✅ FIX 1: Add connection pool settings so Supabase doesn't drop idle connections.
//    The Whisper call can take 60-120s — without pool_timeout the connection
//    times out while we wait, then the subsequent .update() fails.
const webhookPrisma = new PrismaClient( {
  datasourceUrl: process.env.DATABASE_URL,
  log: [ "error" ],
} )

const client = new Client( { token: process.env.QSTASH_TOKEN! } )

const processedBots = new Set<string>()

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

async function processWebhook ( botId: string, webhookData: any )
{
  // ✅ FIX 2: Single try/finally — ONE connect at the start, ONE disconnect at
  //    the end. The original code did $disconnect() mid-function before the
  //    Whisper call, then $connect() after — but Supabase had already dropped
  //    the idle connection by then (especially after a 60-120s Whisper call).
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

    // ✅ FIX 3: Do NOT disconnect here. Keep the connection alive across the
    //    Whisper call. We'll disconnect once in the finally block below.
    let parsedTranscript: any = meeting.transcript

    const transcriptHasContent =
      webhookData.transcript &&
      Array.isArray( webhookData.transcript ) &&
      webhookData.transcript.some(
        ( seg: any ) => seg.words && seg.words.length > 0
      )

    if ( ( !webhookData.transcript || !transcriptHasContent ) && webhookData.audio )
    {
      console.log( `🎙️ No transcript content — transcribing audio with Groq Whisper...` )
      try
      {
        // This can take 60-120s. Connection stays alive (no mid-flow disconnect).
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
          // ✅ FIX 4: Whisper returned null/empty — store null gracefully
          //    instead of leaving parsedTranscript as the stale meeting.transcript.
          console.warn( "⚠️ Whisper returned no segments — storing null transcript" )
          parsedTranscript = null
        }
      } catch ( err )
      {
        console.error( "❌ Transcription failed:", err )
        // ✅ FIX 5: Don't crash the whole webhook on transcription failure.
        //    Mark the meeting as ended with whatever transcript we have (could be null).
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

    // ✅ FIX 6: Always update the meeting — even when parsedTranscript is null.
    //    The original code only ran the update then bailed if transcript was null,
    //    leaving meetingEnded=false forever. Now we always mark it ended.
    await webhookPrisma.meeting.update( {
      where: { id: meeting.id },
      data: {
        meetingEnded: true,
        // Only set transcriptReady=true if we actually have content
        transcriptReady: parsedTranscript !== null,
        transcript: parsedTranscript,
        recordingUrl: webhookData.mp4 || meeting.recordingUrl,
        speakers: webhookData.speakers || meeting.speakers,
      },
    } )

    // ✅ FIX 7: Skip the queue if transcript is null — nothing to process.
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

    console.log(
      `📝 Transcript ready (${ JSON.stringify( updatedMeeting.transcript ).length } bytes). Queuing...`
    )

    const appUrl = process.env.NEXT_PUBLIC_APP_URI
    const response = await client.publishJSON( {
      url: `${ appUrl }/api/queue/process-meeting`,
      body: {
        meetingId: meeting.id,
        transcript: updatedMeeting.transcript,
        botId,
        meetingTitle: meeting.title,
      },
      retries: 0,
    } )

    console.log(
      `📨 Job queued (Msg ID: ${ response.messageId }) for Meeting: ${ meeting.title }`
    )
  } finally
  {
    // ✅ FIX 8: Single disconnect point — always runs, even on error.
    await webhookPrisma.$disconnect()
  }
}

function mergeTranscriptWithSpeakers (
  originalSegments: any[],
  transcribedSegments: any[]
): any[]
{
  if ( !transcribedSegments || transcribedSegments.length === 0 )
    return originalSegments

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