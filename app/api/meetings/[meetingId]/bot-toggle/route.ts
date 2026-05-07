import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> }
) {
  try {
    const { meetingId } = await params;
    const { botScheduled } = await request.json();

    // ✅ Detect server calls (QStash / cron)
    const isServerCall = request.headers.get("upstash-signature");

    let user: any = null;
    let meeting:
      | Awaited<ReturnType<typeof prisma.meeting.findUnique>>
      | null = null;

    // =========================
    // ✅ USER FLOW (Frontend)
    // =========================
    if (!isServerCall) {
      const { userId } = await auth();

      if (!userId) {
        return NextResponse.json(
          { error: "Not authenticated" },
          { status: 401 }
        );
      }

      user = await prisma.user.findUnique({
        where: { clerkId: userId },
      });

      if (!user) {
        return NextResponse.json(
          { error: "User not found" },
          { status: 404 }
        );
      }

      meeting = await prisma.meeting.findUnique({
        where: {
          id: meetingId,
          createdById: user.id,
        },
      });

      if (!meeting) {
        return NextResponse.json(
          { error: "Meeting not found" },
          { status: 404 }
        );
      }

      // ✅ Update toggle
      await prisma.meeting.update({
        where: { id: meetingId },
        data: { botScheduled },
      });

      // ❌ If disabled → exit early
      if (!botScheduled) {
        return NextResponse.json({
          success: true,
          botScheduled: false,
        });
      }
    }

    // =========================
    // ✅ SERVER FLOW (QStash)
    // =========================
    if (isServerCall) {
      meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
       include: { createdBy: true }, 
      });

      if (!meeting) {
        return NextResponse.json(
          { error: "Meeting not found" },
          { status: 404 }
        );
      }

      // Respect manual disable
      if (!meeting.botScheduled) {
        return NextResponse.json({
          success: true,
          skipped: true,
        });
      }

      user = meeting.createdById

    }

    // =========================
    // ✅ FINAL SAFETY CHECK (fix TS error)
    // =========================
    if (!meeting) {
      return NextResponse.json(
        { error: "Meeting not found" },
        { status: 404 }
      );
    }

    // =========================
    // ✅ COMMON LOGIC
    // =========================

    if (!meeting.meetingUrl) {
      return NextResponse.json(
        { error: "No meeting URL" },
        { status: 400 }
      );
    }

    // ❌ Prevent duplicate bot
    if (meeting.botSent) {
      return NextResponse.json({
        success: true,
        alreadySent: true,
      });
    }

    const apiKey = process.env.MEETING_BAAS_API_KEY;
    const webhookUrl =
      process.env.WEBHOOK_URL ||
      `${process.env.NEXT_PUBLIC_APP_URI}/api/webhooks/meetingbaas`;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing MEETING_BAAS_API_KEY" },
        { status: 500 }
      );
    }

    if (!webhookUrl) {
      return NextResponse.json(
        { error: "Missing WEBHOOK_URL" },
        { status: 500 }
      );
    }

    console.log("🚀 Sending bot...");
    console.log("Meeting URL:", meeting.meetingUrl);
    console.log("Webhook URL:", webhookUrl);

    // =========================
    // ✅ CALL MEETING BAAS (v1)
    // =========================
    const response = await fetch("https://api.meetingbaas.com/bots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-meeting-baas-api-key": apiKey,
      },
      body: JSON.stringify({
        meeting_url: meeting.meetingUrl,
        bot_name: user?.botName || "MeetingBot",
        recording_mode: "speaker_view",
        bot_image:
          user?.image || "https://i.pravatar.cc/150?u=MeetingBot",
        entry_message: "Hi, I'm recording this meeting.",
        webhook_url: webhookUrl,
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error("❌ MeetingBaaS ERROR:", raw);
      return NextResponse.json(
        { error: raw },
        { status: 500 }
      );
    }

    const botData = JSON.parse(raw);

    // =========================
    // ✅ SAVE BOT DATA
    // =========================
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        botId: botData.bot_id,
        botSent: true,
        botJoinedAt: new Date(),
      },
    });

    console.log("🤖 Bot sent successfully:", botData.bot_id);

    return NextResponse.json({
      success: true,
      botScheduled: true,
    });

  } catch (error) {
    console.error("🔥 bot-toggle error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
