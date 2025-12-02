import { 
  processMeetingTranscript, 
  generateRiskAnalysis, 
  generateSentimentArc 
} from "@/lib/ai-processor"; // ✅ Updated import
import { prisma } from "@/lib/db";
import { sendMeetingSummaryEmail } from "@/lib/email-service-free";
import { processTranscript } from "@/lib/rag";
import { incrementMeetingUsage } from "@/lib/usage";
import { NextRequest, NextResponse } from "next/server";
import { addToKnowledgeGraph } from "@/lib/graph"; 

export async function POST(request: NextRequest) {
  try {
    const webhook = await request.json()

    if (webhook.event === 'complete') {
      const webhookData = webhook.data

      const meeting = await prisma.meeting.findFirst({
        where: {
          botId: webhookData.bot_id
        },
        include: {
          user: true
        }
      })

      if (!meeting) {
        console.error('meeting not found for bot id:', webhookData.bot_id)
        return NextResponse.json({ error: 'meeting not found' }, { status: 404 })
      }

      await incrementMeetingUsage(meeting.userId)

      if (!meeting.user.email) {
        console.error('user email not found for this meeting', meeting.id)
        return NextResponse.json({ error: 'user email not found' }, { status: 400 })
      }

      // Update basic meeting info immediately
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: {
          meetingEnded: true,
          transcriptReady: true,
          transcript: webhookData.transcript || null,
          recordingUrl: webhookData.mp4 || null,
          speakers: webhookData.speakers || null
        }
      })

      // ---------------------------------------------------
      // PROCESS TRANSCRIPT (SUMMARY + EMAIL + RAG + AGENTS)
      // ---------------------------------------------------
      if (webhookData.transcript && !meeting.processed) {
        try {
          // 1️⃣ Generate standard summary
          const processed = await processMeetingTranscript(webhookData.transcript)

          let transcriptText = ''
          if (Array.isArray(webhookData.transcript)) {
            transcriptText = webhookData.transcript
              .map((item: any) => `${item.speaker || 'Speaker'}: ${item.words.map((w: any) => w.word).join(' ')}`)
              .join('\n')
          } else {
            transcriptText = webhookData.transcript
          }

          // 2️⃣ Send Email
          try {
            await sendMeetingSummaryEmail({
              userEmail: meeting.user.email,
              userName: meeting.user.name || 'User',
              meetingTitle: meeting.title,
              summary: processed.summary,
              actionItems: processed.actionItems,
              meetingId: meeting.id,
              meetingDate: meeting.startTime.toLocaleDateString()
            })

            await prisma.meeting.update({
              where: { id: meeting.id },
              data: { emailSent: true, emailSentAt: new Date() }
            })
          } catch (emailError) {
            console.error('failed to send the email:', emailError)
          }

          // 3️⃣ Process Vector RAG (Standard)
          await processTranscript(meeting.id, meeting.userId, transcriptText, meeting.title)

          // 4️⃣ SAVE SUMMARY + ACTION ITEMS
          await prisma.meeting.update({
            where: { id: meeting.id },
            data: {
              summary: processed.summary,
              actionItems: processed.actionItems,
              processed: true,
              processedAt: new Date(),
              ragProcessed: true,
              ragProcessedAt: new Date()
            }
          })

          // ---------------------------------------------------
          // 🔥 5️⃣ TRIGGER DEVIL’S ADVOCATE (Risk Analysis)
          // ---------------------------------------------------
          console.log("😈 Triggering Devil's Advocate Agent...")
          generateRiskAnalysis(webhookData.transcript, meeting.id)
            .then(() => console.log("😈 Risk Analysis Saved"))
            .catch(e => console.error("😈 Risk Analysis Failed:", e));

          // ---------------------------------------------------
          // 🕸️ 6️⃣ TRIGGER KNOWLEDGE GRAPH (Neo4j)
          // ---------------------------------------------------
          console.log("🕸️ Triggering Graph Extraction...");
          addToKnowledgeGraph(webhookData.transcript, meeting.id, meeting.title)
            .then(() => console.log("🕸️ Graph Populated Successfully"))
            .catch(e => console.error("🕸️ Graph Failed:", e));

          // ---------------------------------------------------
          // 📈 7️⃣ TRIGGER SENTIMENT MAPPING (Temporal)
          // ---------------------------------------------------
          console.log("📈 Triggering Sentiment Mapping...");
          generateSentimentArc(webhookData.transcript, meeting.id)
            .then(() => console.log("📈 Sentiment Data Saved"))
            .catch(e => console.error("📈 Sentiment Failed", e));

        } catch (processingError) {
          console.error('failed to process the transcript:', processingError)

          await prisma.meeting.update({
            where: { id: meeting.id },
            data: {
              processed: true,
              processedAt: new Date(),
              summary: 'processing failed. please check the transcript manually.',
              actionItems: []
            }
          })
        }
      }

      return NextResponse.json({
        success: true,
        message: 'meeting processed succesfully',
        meetingId: meeting.id
      })
    }

    return NextResponse.json({
      success: true,
      message: 'webhook received but no action needed bro'
    })

  } catch (error) {
    console.error('webhook processing error:', error)
    return NextResponse.json({ error: 'internal server error' }, { status: 500 })
  }
}