import { prisma } from "@/lib/db";
import { incrementMeetingUsage } from "@/lib/usage";
import { NextRequest, NextResponse } from "next/server";
import { Client } from "@upstash/qstash";
import crypto from "crypto";

// Initialize Queue Client
const client = new Client({ token: process.env.QSTASH_TOKEN! });

export async function POST(request: NextRequest) {
    try {
        // 1. Read Raw Body (Needed for Signature Verification)
        const bodyText = await request.text();
        
        // 2. Security: Verify Signature
        // We check if the request actually came from Meeting Baas using your Secret
        const signature = request.headers.get("x-meeting-baas-signature");
        const secret = process.env.MEETING_BAAS_WEBHOOK_SECRET;

        if (!secret) {
            console.warn("⚠️ MEETING_BAAS_WEBHOOK_SECRET is missing in .env. Skipping verification.");
        } else if (!signature) {
             return NextResponse.json({ error: "Missing signature header" }, { status: 401 });
        } else {
            // Verify HMAC-SHA256 Signature
            const hmac = crypto.createHmac("sha256", secret);
            const digest = hmac.update(bodyText).digest("hex");
            
            if (digest !== signature) {
                console.error("❌ Invalid Webhook Signature. Potential attack.");
                return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
            }
        }

        // 3. Parse JSON from the raw body
        const webhook = JSON.parse(bodyText);

        if (webhook.event === 'complete') {
            const webhookData = webhook.data;
            
            console.log(`🔔 Webhook Received for Bot ID: ${webhookData.bot_id}`);

            // 4. Find Meeting (Fixed Prisma Relations)
            const meeting = await prisma.meeting.findFirst({
                where: { botId: webhookData.bot_id },
                include: { createdBy: true } // ✅ Fixed: 'user' -> 'createdBy' based on your schema
            });

            if (!meeting) {
                console.error('❌ Meeting not found for bot id:', webhookData.bot_id);
                return NextResponse.json({ error: 'meeting not found' }, { status: 404 });
            }

            // 5. Immediate Updates (Fast DB operations only)
            // ✅ Fixed: 'userId' -> 'createdById' based on your schema
            await incrementMeetingUsage(meeting.createdById);
            
            await prisma.meeting.update({
                where: { id: meeting.id },
                data: {
                    meetingEnded: true,
                    transcriptReady: true,
                    // Store raw data immediately
                    transcript: webhookData.transcript, 
                    recordingUrl: webhookData.mp4,
                    speakers: webhookData.speakers
                }
            });

            // 6. 🚀 DISPATCH TO ASYNC QUEUE (QStash)
            // We do NOT process AI here. We send it to a background worker.
            const appUrl = process.env.NEXT_PUBLIC_APP_URI; 
            
            try {
                const response = await client.publishJSON({
                    url: `${appUrl}/api/queue/process-meeting`,
                    body: {
                        meetingId: meeting.id,
                        transcript: webhookData.transcript,
                        botId: webhookData.bot_id,
                        meetingTitle: meeting.title 
                    },
                    retries: 3 // Auto-retry if AI fails
                });
                
                console.log(`📨 Job sent to Queue (Msg ID: ${response.messageId}) for Meeting: ${meeting.id}`);
            
            } catch (queueError) {
                console.error("❌ Failed to queue job:", queueError);
                // We still return success to MeetingBaas so they stop retrying the webhook
            }

            return NextResponse.json({ success: true, message: 'Queued for processing' });
        }

        // Handle other events (failed, etc.) or just acknowledge
        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
    }
}