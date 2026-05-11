/**
 * app/api/evals/results/route.ts
 * GET — returns latest eval results + history from Redis
 */

import { NextRequest, NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { Redis } from "@upstash/redis"
import type { EvalRunSummary } from "@/lib/evals"

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const runId = searchParams.get("runId") // optional — fetch specific run

    if (runId) {
      const run = await redis.get<EvalRunSummary>(`evals:run:${runId}`)
      if (!run) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 })
      }
      return NextResponse.json(run)
    }

    // Default: return latest run + history of run IDs
    const [latest, history] = await Promise.all([
      redis.get<EvalRunSummary>("evals:latest"),
      redis.lrange<string>("evals:history", 0, 9), // last 10 run IDs
    ])

    if (!latest) {
      return NextResponse.json({ error: "No eval runs found. Run POST /api/evals/run first." }, { status: 404 })
    }

    return NextResponse.json({ latest, history })
  } catch (error) {
    console.error("Failed to fetch eval results:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch results" },
      { status: 500 }
    )
  }
}