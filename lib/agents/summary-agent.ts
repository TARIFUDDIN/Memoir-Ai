/**
 * SUMMARY AGENT
 * Phase 3.2 — Multi-Agent Orchestration
 *
 * Responsibilities:
 *  - Generate a 3-part executive summary (context / decisions / outlook)
 *  - Extract a numbered action-item list
 *  - Persist both to the Meeting record in Prisma
 *
 * Caching: both sub-tasks are cached individually so a partial retry
 * (e.g. DB write failed) re-uses Groq results without new API spend.
 */

import { prisma } from "@/lib/db"
import {
  BaseAgent,
  AgentRunOptions,
  buildCacheKey,
  getCachedOrGenerate,
  normalizeTranscript,
  truncateTranscript,
  validateTranscript,
} from "./base-agent"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecutiveSummary = {
  context: string
  decisions: string
  outlook: string
}

export type ActionItem = {
  id: number
  text: string
}

export type SummaryAgentOutput = {
  executiveSummary: ExecutiveSummary
  summary: string
  actionItems: ActionItem[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TRANSCRIPT_MAX_LENGTH = 20_000

const TEMPERATURE = {
  EXECUTIVE: 0.3,
  MEETING: 0.3,
} as const

// ─── Agent ────────────────────────────────────────────────────────────────────

export class SummaryAgent extends BaseAgent<SummaryAgentOutput>
{
  readonly taskName = "summary_agent"

  protected async execute ( { meetingId, transcript }: AgentRunOptions ): Promise<SummaryAgentOutput>
  {
    const text = normalizeTranscript( transcript )
    const validation = validateTranscript( text, TRANSCRIPT_MAX_LENGTH )
    if ( !validation.valid ) throw new Error( validation.error )
    const truncated = truncateTranscript( text, TRANSCRIPT_MAX_LENGTH )

    // Run both sub-tasks in parallel — each has its own cache entry.
    const [ executiveSummary, processed ] = await Promise.all( [
      this._generateExecutiveSummary( truncated ),
      this._processMeetingTranscript( truncated ),
    ] )

    // Persist to DB — this must succeed before the idempotency key is set.
    await prisma.meeting.update( {
      where: { id: meetingId },
      data: {
        summary: processed.summary,
        actionItems: processed.actionItems,
        processed: true,
        processedAt: new Date(),
      },
    } )

    return {
      executiveSummary,
      summary: processed.summary,
      actionItems: processed.actionItems,
    }
  }

  // ── Sub-task 1: Executive Summary ─────────────────────────────────────────

  private async _generateExecutiveSummary ( truncated: string ): Promise<ExecutiveSummary>
  {
    return getCachedOrGenerate<ExecutiveSummary>(
      "executive_summary",
      truncated,
      async () =>
      {
        const raw = await this.callGroq( {
          temperature: TEMPERATURE.EXECUTIVE,
          maxTokens: 500,
          messages: [
            {
              role: "system",
              content: `You are a business analyst specialising in meeting summarisation.
Extract exactly 3 components. Return ONLY valid JSON:
{
  "context": "1-2 sentences about meeting topic, attendees, purpose",
  "decisions": "2-3 sentences of KEY decisions made",
  "outlook": "1-2 sentences about next steps, timeline, implications"
}`,
            },
            { role: "user", content: truncated },
          ],
        } )

        return this.parseJSON<ExecutiveSummary>( raw, [ "context", "decisions", "outlook" ] )
      }
    )
  }

  // ── Sub-task 2: Meeting Summary + Action Items ────────────────────────────

  private async _processMeetingTranscript (
    truncated: string
  ): Promise<{ summary: string; actionItems: ActionItem[] }>
  {
    return getCachedOrGenerate<{ summary: string; actionItems: ActionItem[] }>(
      "meeting_transcript",
      truncated,
      async () =>
      {
        const raw = await this.callGroq( {
          temperature: TEMPERATURE.MEETING,
          maxTokens: 800,
          messages: [
            {
              role: "system",
              content: `You are a meeting analysis expert.
Analyse the transcript and return ONLY valid JSON:
{
  "summary": "2-3 sentence summary of the meeting",
  "actionItems": [
    { "id": 1, "text": "Action item description" }
  ]
}`,
            },
            { role: "user", content: truncated },
          ],
        } )

        return this.parseJSON<{ summary: string; actionItems: ActionItem[] }>(
          raw,
          [ "summary", "actionItems" ]
        )
      }
    )
  }
}

// ─── Singleton export (avoids re-instantiation on every QStash invocation) ───
export const summaryAgent = new SummaryAgent()
