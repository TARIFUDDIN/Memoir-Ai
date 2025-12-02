import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export async function POST(
    request: Request,
    { params }: { params: Promise<{ meetingId: string }> }
) {
    try {
        const { userId } = await auth()
        if (!userId) {
            return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
        }

        const { meetingId } = await params
        const { botScheduled } = await request.json()

        // 1. Verify User and Get Meeting Details (We need the URL!)
        const user = await prisma.user.findUnique({
            where: { clerkId: userId }
        })

        if (!user) {
            return NextResponse.json({ error: "User not found" }, { status: 404 })
        }

        const meeting = await prisma.meeting.findUnique({
            where: {
                id: meetingId,
                userId: user.id
            }
        })

        if (!meeting) {
            return NextResponse.json({ error: "Meeting not found" }, { status: 404 })
        }

        // 2. Update the Database "Preference" first
        await prisma.meeting.update({
            where: { id: meetingId },
            data: { botScheduled: botScheduled }
        })

        // 3. If turning ON, actually Spawn the Bot
        if (botScheduled) {
            if (!meeting.meetingUrl) {
                return NextResponse.json({ 
                    error: "Cannot join: No meeting URL found for this event" 
                }, { status: 400 })
            }

            // ⚠️ CRITICAL: Meeting Baas cannot send webhooks to localhost.
            // If testing locally, you must use ngrok, or this part will fail to return data.
            // For now, we use your NEXT_PUBLIC_APP_URI.
            const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URI}/api/webhooks/meetingbaas`
            const apiKey = process.env.MEETING_BAAS_API_KEY

            if (!apiKey) {
                console.error("MEETING_BAAS_API_KEY is missing")
                return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 })
            }

            try {
                const response = await fetch("https://api.meetingbaas.com/bots", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-meeting-baas-api-key": apiKey,
                    },
                    body: JSON.stringify({
                        meeting_url: meeting.meetingUrl,
                        bot_name: "MeetingBot", // or user.botName
                        recording_mode: "speaker_view",
                        bot_image: user.botImageUrl || "https://i.pravatar.cc/150?u=MeetingBot",
                        entry_message: "Hi, I'm recording this meeting to generate notes.",
                        webhook_url: webhookUrl,
                    }),
                })

                if (!response.ok) {
                    const errorText = await response.text()
                    console.error("Failed to spawn bot:", errorText)
                    return NextResponse.json({ 
                        error: "Failed to connect to meeting bot service" 
                    }, { status: 502 })
                }

                const botData = await response.json()

                // 4. Save the Bot ID so we can handle the webhook later
                await prisma.meeting.update({
                    where: { id: meetingId },
                    data: {
                        botId: botData.bot_id,
                        botSent: true,
                        botJoinedAt: new Date()
                    }
                })

            } catch (apiError) {
                console.error("External API Call Failed:", apiError)
                return NextResponse.json({ error: "Failed to reach bot service" }, { status: 500 })
            }
        }

        return NextResponse.json({
            success: true,
            botScheduled: botScheduled,
            message: botScheduled ? 'Bot joining meeting...' : 'Bot scheduled disabled'
        })

    } catch (error) {
        console.error('Bot toggle error:', error)
        return NextResponse.json({
            error: "Failed to update bot status"
        }, { status: 500 })
    }
}