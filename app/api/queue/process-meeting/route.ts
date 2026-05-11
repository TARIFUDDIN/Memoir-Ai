import { NextRequest, NextResponse } from "next/server"
import { verifySignatureAppRouter } from "@upstash/qstash/dist/nextjs"
import
  {
    processMeetingTranscript,
    generateRiskAnalysis,
    generateSentimentArc,
    generateSpeakerProfiles,
  } from "@/lib/ai-processor"
import { addToKnowledgeGraph } from "@/lib/graph"
import { prisma } from "@/lib/db"
import { processTranscript } from "@/lib/rag"
import { sendMeetingSummaryEmail } from "@/lib/email-service-free"
import type { MeetingTaskType } from "@/app/api/webhooks/meetingbaas/route"

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler ( req: NextRequest )
{
  const body = await req.json()
  const { meetingId, transcript, botId, taskType } = body as {
    meetingId: string
    transcript: unknown
    botId: string
    meetingTitle?: string
    taskType: MeetingTaskType
  }

  // Guard: taskType is required.  A missing taskType means this job came from
  // an old webhook before the fan-out refactor.  Run the full legacy path so
  // existing in-flight jobs aren't silently dropped.
  if ( !taskType )
  {
    console.warn( "⚠️ No taskType in payload — running legacy monolithic path" )
    return legacyHandler( req, body )
  }

  console.log( `👷 Worker [${ taskType }] started — meeting ${ meetingId }` )

  try
  {
    const meeting = await prisma.meeting.findUnique( {
      where: { id: meetingId },
      include: { createdBy: true },
    } )

    if ( !meeting )
    {
      return NextResponse.json( { error: "Meeting not found" }, { status: 404 } )
    }

    // ── Route to the correct task ──────────────────────────────────────────
    switch ( taskType )
    {
      // ── SUMMARY: process transcript + email + persist ──────────────────
      case "SUMMARY": {
        const processed = await processMeetingTranscript( transcript )

        await sendMeetingSummaryEmail( {
          userEmail: meeting.createdBy.email!,
          userName: meeting.createdBy.name || "User",
          meetingTitle: meeting.title,
          summary: processed.summary,
          actionItems: processed.actionItems,
          meetingId: meeting.id,
          meetingDate: meeting.startTime.toLocaleDateString(),
        } )

        await prisma.meeting.update( {
          where: { id: meetingId },
          data: {
            summary: processed.summary,
            actionItems: processed.actionItems,
            processed: true,
            processedAt: new Date(),
          },
        } )

        // RAG ingestion lives here because it needs the summary to be written
        // first and it logically belongs to the "text processing" task.
        // processTranscript uses parent-child chunking internally:
        //   - Child chunks (~100 tokens) → Pinecone (precise retrieval)
        //   - Parent content (~500 tokens) → NeonDB TranscriptChunk.parentContent
        await processTranscript(
          meetingId,
          meeting.createdById,
          JSON.stringify( transcript ),
          meeting.title
        )

        await prisma.meeting.update( {
          where: { id: meetingId },
          data: { ragProcessed: true, ragProcessedAt: new Date() },
        } )

        console.log( `✅ [SUMMARY] complete — meeting ${ meetingId }` )
        break
      }

      // ── RISK ───────────────────────────────────────────────────────────
      case "RISK": {
        await generateRiskAnalysis( transcript, meetingId )
        console.log( `✅ [RISK] complete — meeting ${ meetingId }` )
        break
      }

      // ── SENTIMENT ─────────────────────────────────────────────────────
      case "SENTIMENT": {
        await generateSentimentArc( transcript, meetingId )
        console.log( `✅ [SENTIMENT] complete — meeting ${ meetingId }` )
        break
      }

      // ── PROFILES ──────────────────────────────────────────────────────
      case "PROFILES": {
        await generateSpeakerProfiles( transcript, meetingId )
        console.log( `✅ [PROFILES] complete — meeting ${ meetingId }` )
        break
      }

      // ── GRAPH ─────────────────────────────────────────────────────────
      case "GRAPH": {
        await addToKnowledgeGraph( transcript, meetingId, meeting.title )
        console.log( `✅ [GRAPH] complete — meeting ${ meetingId }` )
        break
      }

      default: {
        const exhaustive: never = taskType
        console.error( `❌ Unknown taskType: ${ exhaustive }` )
        return NextResponse.json( { error: `Unknown taskType: ${ taskType }` }, { status: 400 } )
      }
    }

    return NextResponse.json( { success: true, taskType } )
  } catch ( error )
  {
    console.error( `❌ Worker [${ taskType }] failed — meeting ${ meetingId }:`, error )
    // Return 500 so QStash knows to retry this specific task.
    return NextResponse.json(
      { error: "Task failed", taskType },
      { status: 500 }
    )
  }
}

export const POST = verifySignatureAppRouter( handler )

// ─── Legacy monolithic path (backward compat) ─────────────────────────────────
//
// Handles jobs queued before the fan-out refactor (taskType absent).
// Can be removed once all in-flight jobs have drained.

async function legacyHandler ( _req: NextRequest, body: any )
{
  const { meetingId, transcript } = body

  try
  {
    const meeting = await prisma.meeting.findUnique( {
      where: { id: meetingId },
      include: { createdBy: true },
    } )

    if ( !meeting )
    {
      return NextResponse.json( { error: "Meeting not found" }, { status: 404 } )
    }

    const processed = await processMeetingTranscript( transcript )

    await sendMeetingSummaryEmail( {
      userEmail: meeting.createdBy.email!,
      userName: meeting.createdBy.name || "User",
      meetingTitle: meeting.title,
      summary: processed.summary,
      actionItems: processed.actionItems,
      meetingId: meeting.id,
      meetingDate: meeting.startTime.toLocaleDateString(),
    } )

    await prisma.meeting.update( {
      where: { id: meetingId },
      data: {
        summary: processed.summary,
        actionItems: processed.actionItems,
        processed: true,
        processedAt: new Date(),
      },
    } )

    const results = await Promise.allSettled( [
      processTranscript( meetingId, meeting.createdById, JSON.stringify( transcript ), meeting.title ),
      generateRiskAnalysis( transcript, meetingId ),
      addToKnowledgeGraph( transcript, meetingId, meeting.title ),
      generateSentimentArc( transcript, meetingId ),
      generateSpeakerProfiles( transcript, meetingId ),
    ] )

    results.forEach( ( r, i ) =>
    {
      if ( r.status === "rejected" )
      {
        const labels = [ "RAG", "Risk", "Graph", "Sentiment", "Profiles" ]
        console.error( `❌ ${ labels[ i ] } failed:`, r.reason )
      }
    } )

    await prisma.meeting.update( {
      where: { id: meetingId },
      data: { ragProcessed: true, ragProcessedAt: new Date() },
    } )

    console.log( `✅ Legacy worker finished: meeting ${ meetingId }` )
    return NextResponse.json( { success: true } )
  } catch ( error )
  {
    console.error( "❌ Legacy worker failed:", error )
    return NextResponse.json( { error: "Processing failed" }, { status: 500 } )
  }
}