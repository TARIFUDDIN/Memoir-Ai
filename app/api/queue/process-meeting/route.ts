import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/dist/nextjs";
import {
  processMeetingTranscript,
  generateRiskAnalysis,
  generateSentimentArc,
  generateSpeakerProfiles,
} from "@/lib/ai-processor";
import { addToKnowledgeGraph } from "@/lib/graph";
import { prisma } from "@/lib/db";
import { processTranscript } from "@/lib/rag";
import { sendMeetingSummaryEmail } from "@/lib/email-service-free";

async function handler(req: NextRequest) {
  console.log("👷 Worker Started: Processing Meeting...");
  const body = await req.json();
  const { meetingId, transcript, botId } = body;

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: { createdBy: true },
    });

    if (!meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    // ── 1. Summary + action items ─────────────────────────
    const processed = await processMeetingTranscript(transcript);

    // ── 2. Email ──────────────────────────────────────────
    await sendMeetingSummaryEmail({
      userEmail: meeting.createdBy.email!,
      userName: meeting.createdBy.name || "User",
      meetingTitle: meeting.title,
      summary: processed.summary,
      actionItems: processed.actionItems,
      meetingId: meeting.id,
      meetingDate: meeting.startTime.toLocaleDateString(),
    });

    // ── 3. Persist summary ────────────────────────────────
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        summary: processed.summary,
        actionItems: processed.actionItems,
        processed: true,
        processedAt: new Date(),
      },
    });

    // ── 4. Parallel advanced tasks ────────────────────────
    // processTranscript now uses parent-child chunking internally:
    //   - Child chunks (≈100 tokens) → Pinecone (precise retrieval)
    //   - Parent content (≈500 tokens) → NeonDB TranscriptChunk.parentContent
    // Everything else is unchanged from the caller's perspective.
    const results = await Promise.allSettled([
      processTranscript(
        meetingId,
        meeting.createdById,
        JSON.stringify(transcript),
        meeting.title
      ),
      generateRiskAnalysis(transcript, meetingId),
      addToKnowledgeGraph(transcript, meetingId, meeting.title),
      generateSentimentArc(transcript, meetingId),
      generateSpeakerProfiles(transcript, meetingId),
    ]);

    // Log any failures without crashing the worker
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const labels = ["RAG", "Risk", "Graph", "Sentiment", "Profiles"];
        console.error(`❌ ${labels[i]} failed:`, r.reason);
      }
    });

    // Mark RAG as processed
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { ragProcessed: true, ragProcessedAt: new Date() },
    });

    console.log(`✅ Worker Finished: Meeting ${meetingId} fully processed.`);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("❌ Worker Failed:", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

export const POST = verifySignatureAppRouter(handler);