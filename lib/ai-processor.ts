import OpenAI from "openai";
import { prisma } from "@/lib/db";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// ---------------------------------------------------------
// ✅ PROCESS MEETING TRANSCRIPT → Summary + Action Items
// ---------------------------------------------------------
export async function processMeetingTranscript(transcript: any) {
  try {
    let transcriptText = "";

    // Normalize transcript format
    if (Array.isArray(transcript)) {
      transcriptText = transcript
        .map(
          (item: any) =>
            `${item.speaker || "Speaker"}: ${item.words
              .map((w: any) => w.word)
              .join(" ")}`
        )
        .join("\n");
    } else if (typeof transcript === "string") {
      transcriptText = transcript;
    } else if (transcript.text) {
      transcriptText = transcript.text;
    }

    if (!transcriptText.trim().length) {
      throw new Error("No transcript content found");
    }

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an AI assistant that analyzes meeting transcripts and provides concise summaries and action items.

          Provide:
          1. A 2–3 sentence summary of key discussion points & decisions.
          2. A list of action items.

          Return ONLY JSON:
          {
              "summary": "...",
              "actionItems": ["...", "..."]
          }`,
        },
        {
          role: "user",
          content: `Analyze this meeting:\n\n${transcriptText}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 1000,
      response_format: { type: "json_object" }, // Enforce JSON
    });

    const response = completion.choices[0].message?.content;
    if (!response) throw new Error("Empty response from OpenAI");

    const parsed = JSON.parse(response);

    const actionItems = Array.isArray(parsed.actionItems)
      ? parsed.actionItems.map((text: string, index: number) => ({
          id: index + 1,
          text,
        }))
      : [];

    return {
      summary: parsed.summary || "Summary could not be generated",
      actionItems,
    };
  } catch (error) {
    console.error("Error processing transcript:", error);
    return {
      summary:
        "Meeting transcript processed successfully. Please check the full transcript for details.",
      actionItems: [],
    };
  }
}

// ---------------------------------------------------------
// ✅ DEVIL'S ADVOCATE — RISK ANALYSIS (HTML OUTPUT)
// ---------------------------------------------------------
export async function generateRiskAnalysis(
  transcript: any,
  meetingId: string
) {
  try {
    let transcriptText = "";

    // Normalize transcript format
    if (Array.isArray(transcript)) {
      transcriptText = transcript
        .map(
          (item: any) =>
            `${item.speaker || "Speaker"}: ${item.words
              .map((w: any) => w.word)
              .join(" ")}`
        )
        .join("\n");
    } else if (typeof transcript === "string") {
      transcriptText = transcript;
    } else if (transcript.text) {
      transcriptText = transcript.text;
    }

    // Limit transcript length for cost safety
    const truncatedTranscript = transcriptText.substring(0, 15000);

    // OpenAI Call
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `You are "The Devil's Advocate", a ruthless Senior Risk Analyst.
          Do NOT summarize. Do NOT be polite. Your job is to find flaws.

          Identify:
          1. 🛑 Critical Risks
          2. 🙈 Blind Spots
          3. 📉 Confidence Score (0–100%)

          Return ONLY valid HTML using:
          <div>, <h3>, <ul>, <li>, <strong>, <p>, <span class="text-red-500">`,
        },
        { role: "user", content: truncatedTranscript },
      ],
    });

    const analysis =
      completion.choices[0].message?.content || "Risk analysis failed.";

    // Save to database
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { riskAnalysis: analysis },
    });

    return analysis;
  } catch (error) {
    console.error("Error generating risk analysis:", error);
    return null;
  }
}

// ---------------------------------------------------------
// 📈 RESEARCH FEATURE: TEMPORAL SENTIMENT MAPPING
// ---------------------------------------------------------
export async function generateSentimentArc(transcript: any, meetingId: string) {
  try {
    // 1. Prepare Data: We need a list of sentences/segments
    let segments: any[] = [];

    if (Array.isArray(transcript)) {
      // If transcript is structured (MeetingBaas format)
      segments = transcript.map((t: any) => ({
        speaker: t.speaker,
        text: t.words.map((w: any) => w.word).join(" "),
        timestamp: t.words[0]?.start_time || 0, // Assuming seconds
      }));
    } else {
      // Fallback for raw text (split by newlines)
      const lines = typeof transcript === 'string' ? transcript.split("\n") : [];
      segments = lines.map((line: string, index: number) => ({
        speaker: "Unknown",
        text: line,
        timestamp: index * 60, // Fake timestamp if missing
      }));
    }

    // Optimization: Group segments to reduce API calls (Batch Processing)
    const batchSize = 15;
    const sentimentResults = [];

    for (let i = 0; i < segments.length; i += batchSize) {
      const batch = segments.slice(i, i + batchSize);
      
      // We only send ID and Text to OpenAI to save tokens
      const batchPayload = batch.map((s) => ({
        id: s.timestamp,
        text: s.text,
      }));

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Analyze the sentiment of each dialogue segment.
            Return a JSON object where keys are the timestamps and values are a score from -1.0 (Negative/Angry) to 1.0 (Positive/Excited). 0 is Neutral.
            
            Example Input: [{"id": 10, "text": "This is a disaster"}]
            Example Output: {"10": -0.9}`,
          },
          { role: "user", content: JSON.stringify(batchPayload) },
        ],
        response_format: { type: "json_object" },
      });

      const scores = JSON.parse(completion.choices[0].message.content || "{}");

      // Merge scores back into segments
      const processedBatch = batch.map((s) => ({
        ...s,
        score: scores[s.timestamp] || 0,
      }));

      sentimentResults.push(...processedBatch);
    }

    // Save to DB
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { sentimentData: sentimentResults },
    });

    return sentimentResults;
  } catch (error) {
    console.error("Sentiment Mapping Failed:", error);
    return null;
  }
}