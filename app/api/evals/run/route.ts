/**
 * app/api/evals/run/route.ts
 * POST — triggers a full eval run for the authenticated user
 * Results stored in Upstash Redis
 */

import { NextRequest, NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { Redis } from "@upstash/redis"
import { runEvals, type EvalQuestion, type EvalRunSummary } from "@/lib/evals"
import dataset from "@/evals/dataset.json"

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Optional: run only a subset { "questionIds": ["q1", "q2"] }
    const body = await req.json().catch(() => ({})) as { questionIds?: string[] }
    const questions: EvalQuestion[] = body.questionIds?.length
      ? (dataset as EvalQuestion[]).filter((q) => body.questionIds!.includes(q.id))
      : (dataset as EvalQuestion[])

    if (questions.length === 0) {
      return NextResponse.json({ error: "No questions found in dataset" }, { status: 400 })
    }

    console.log(`🧪 Eval run triggered by ${userId}: ${questions.length} questions`)

    // Run evals — this takes time, stream progress via SSE if needed in future
    const summary = await runEvals(userId, questions)

    // Store in Redis
    await Promise.all([
      redis.set("evals:latest", JSON.stringify(summary)),
      redis.set(`evals:run:${summary.runId}`, JSON.stringify(summary), { ex: 60 * 60 * 24 * 30 }), // 30 days
      redis.lpush("evals:history", summary.runId),
      redis.ltrim("evals:history", 0, 49), // keep last 50 run IDs
    ])

    return NextResponse.json({
      success: true,
      runId:          summary.runId,
      passRate:       summary.passRate,
      totalQuestions: summary.totalQuestions,
      passedQuestions: summary.passedQuestions,
      avgFaithfulness:     summary.avgFaithfulness,
      avgAnswerRelevancy:  summary.avgAnswerRelevancy,
      avgContextPrecision: summary.avgContextPrecision,
      avgContextRecall:    summary.avgContextRecall,
      avgLatencyMs:        summary.avgLatencyMs,
    })
  } catch (error) {
    console.error("Eval run failed:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Eval run failed" },
      { status: 500 }
    )
  }
}