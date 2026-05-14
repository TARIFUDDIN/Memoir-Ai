/**
 * RISK AGENT
 * Phase 3.2 — Multi-Agent Orchestration
 *
 * Responsibilities:
 *  - Identify critical risks, blind spots, and confidence score from transcript
 *  - Produce an HTML-formatted risk report
 *  - Persist the result to Meeting.riskAnalysis (JSON string)
 *
 * Caching: result is cached by transcript hash (7 days).
 */

import { prisma } from "@/lib/db"
import {
  BaseAgent,
  AgentRunOptions,
  getCachedOrGenerate,
  normalizeTranscript,
  truncateTranscript,
  validateTranscript,
} from "./base-agent"

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskAnalysisResult = {
  html: string
  criticalRisks: string[]
  blindSpots: string[]
  confidenceScore: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TRANSCRIPT_MAX_LENGTH = 20_000
const TEMPERATURE = 0.7

// ─── Agent ────────────────────────────────────────────────────────────────────

export class RiskAgent extends BaseAgent<RiskAnalysisResult>
{
  readonly taskName = "risk_analysis"

  protected async execute ( { meetingId, transcript }: AgentRunOptions ): Promise<RiskAnalysisResult>
  {
    const text = normalizeTranscript( transcript )
    const validation = validateTranscript( text, TRANSCRIPT_MAX_LENGTH )
    if ( !validation.valid ) throw new Error( validation.error )
    const truncated = truncateTranscript( text, TRANSCRIPT_MAX_LENGTH )

    const result = await getCachedOrGenerate<RiskAnalysisResult>(
      "risk_analysis",
      truncated,
      async () =>
      {
        const raw = await this.callGroq( {
          temperature: TEMPERATURE,
          maxTokens: 1500,
          messages: [
            {
              role: "system",
              content: `You are a risk analysis expert and devil's advocate.
Analyse the meeting transcript for risks, assumptions, and blind spots.
Return ONLY valid JSON:
{
  "html": "<div>HTML formatted risk report with sections for Critical Risks, Blind Spots, and Recommendations</div>",
  "criticalRisks": ["risk description 1", "risk description 2"],
  "blindSpots": ["blind spot description 1"],
  "confidenceScore": 75
}
confidenceScore is an integer 0-100 representing your confidence in the analysis.`,
            },
            { role: "user", content: truncated },
          ],
        } )

        return this.parseJSON<RiskAnalysisResult>(
          raw,
          [ "html", "criticalRisks", "blindSpots", "confidenceScore" ]
        )
      }
    )

    // Persist — must succeed before idempotency key is written.
    await prisma.meeting.update( {
      where: { id: meetingId },
      data: { riskAnalysis: JSON.stringify( result ) },
    } )

    return result
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const riskAgent = new RiskAgent()
