import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/dist/nextjs";
import { processMeetingTranscript, generateRiskAnalysis, generateSentimentArc, generateSpeakerProfiles } from "@/lib/ai-processor";
import { addToKnowledgeGraph } from "@/lib/graph";
import { prisma } from "@/lib/db";
import { processTranscript } from "@/lib/rag";
import { sendMeetingSummaryEmail } from "@/lib/email-service-free";

// This function processes the heavy job
async function handler(req: NextRequest) {
    console.log("👷 Worker Started: Processing Meeting...");
    const body = await req.json();
    const { meetingId, transcript, botId } = body;

    try {
        const meeting = await prisma.meeting.findUnique({
            where: { id: meetingId },
            include: { user: true }
        });

        if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

        // 1. Generate Summary & Action Items
        const processed = await processMeetingTranscript(transcript);

        // 2. Send Email
        await sendMeetingSummaryEmail({
            userEmail: meeting.user.email!,
            userName: meeting.user.name || 'User',
            meetingTitle: meeting.title,
            summary: processed.summary,
            actionItems: processed.actionItems,
            meetingId: meeting.id,
            meetingDate: meeting.startTime.toLocaleDateString()
        });

        // 3. Update DB with Summary
        await prisma.meeting.update({
            where: { id: meetingId },
            data: {
                summary: processed.summary,
                actionItems: processed.actionItems,
                processed: true,
                processedAt: new Date(),
            }
        });

        // 4. PARALLEL: Run all advanced AI tasks
        // We use Promise.allSettled so if one fails, others still finish
        await Promise.allSettled([
            // Vector RAG
            processTranscript(meetingId, meeting.userId, JSON.stringify(transcript), meeting.title),
            
            // 😈 Risk Analysis
            generateRiskAnalysis(transcript, meetingId),
            
            // 🕸️ Graph Extraction
            addToKnowledgeGraph(transcript, meetingId, meeting.title),
            
            // 📈 Sentiment Arc
            generateSentimentArc(transcript, meetingId),
            
            // 🧠 Behavioral Profiling (If you implemented it)
            generateSpeakerProfiles(transcript, meetingId)
        ]);

        console.log(`✅ Worker Finished: Meeting ${meetingId} fully processed.`);
        return NextResponse.json({ success: true });

    } catch (error) {
        console.error("❌ Worker Failed:", error);
        return NextResponse.json({ error: "Processing failed" }, { status: 500 });
    }
}

// Security: Verify that the request actually came from QStash
export const POST = verifySignatureAppRouter(handler);