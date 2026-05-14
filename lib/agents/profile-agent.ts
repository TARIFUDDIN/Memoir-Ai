/**
 * PROFILE AGENT
 * Phase 3.2 — Multi-Agent Orchestration
 *
 * Responsibilities:
 *  - Generate a behavioural profile for each identified speaker
 *    (role, sentiment, dominant trait, one-sentence feedback)
 *  - Validate that every profile is complete before accepting the result
 *  - Persist profiles to Meeting.speakerProfiles
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

export type SpeakerProfile = {
  /** Inferred role in the meeting (e.g. "Project Lead", "Stakeholder"). */
  role: string
  /** Overall emotional tone — strict union to match UI expectations. */
  sentiment: "Positive" | "Neutral" | "Negative"
  /** Single dominant behavioural trait (e.g. "Visionary", "Analytical"). */
  trait: string
  /** One-sentence constructive feedback for this speaker. */
  feedback: string
}

export type SpeakerProfiles = {
  [ speakerName: string ]: SpeakerProfile
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TRANSCRIPT_MAX_LENGTH = 20_000
const TEMPERATURE = 0.5

// ─── Agent ────────────────────────────────────────────────────────────────────

export class ProfileAgent extends BaseAgent<SpeakerProfiles>
{
  readonly taskName = "speaker_profiles"

  protected async execute ( { meetingId, transcript }: AgentRunOptions ): Promise<SpeakerProfiles>
  {
    const text = normalizeTranscript( transcript )
    const validation = validateTranscript( text, TRANSCRIPT_MAX_LENGTH )
    if ( !validation.valid ) throw new Error( validation.error )
    const truncated = truncateTranscript( text, TRANSCRIPT_MAX_LENGTH )

    const profiles = await getCachedOrGenerate<SpeakerProfiles>(
      "speaker_profiles",
      truncated,
      async () =>
      {
        const raw = await this.callGroq( {
          temperature: TEMPERATURE,
          maxTokens: 1200,
          messages: [
            {
              role: "system",
              content: `Generate behavioural profiles for every speaker identified in the transcript.
Return ONLY valid JSON keyed by speaker name:
{
  "Alice": {
    "role": "Project Lead",
    "sentiment": "Positive",
    "trait": "Visionary",
    "feedback": "One sentence of constructive, actionable feedback."
  }
}
IMPORTANT:
- "sentiment" must be exactly one of: "Positive" | "Neutral" | "Negative"
- Include every distinct speaker found in the transcript.
- Do not add any speakers who do not appear in the transcript.`,
            },
            { role: "user", content: truncated },
          ],
        } )

        return this.parseJSON<SpeakerProfiles>( raw )
      }
    )

    // Validate completeness — reject the whole result if no profiles are usable.
    const validProfiles: SpeakerProfiles = {}
    for ( const [ speaker, profile ] of Object.entries( profiles ) )
    {
      if ( profile.role && profile.sentiment && profile.trait && profile.feedback )
      {
        validProfiles[ speaker ] = profile
      } else
      {
        console.warn( `⚠️  Incomplete profile for speaker "${ speaker }" — excluded` )
      }
    }

    if ( Object.keys( validProfiles ).length === 0 )
    {
      throw new Error( "NO_VALID_SPEAKER_PROFILES" )
    }

    // Persist — must succeed before idempotency key is written.
    await prisma.meeting.update( {
      where: { id: meetingId },
      data: { speakerProfiles: validProfiles as any },
    } )

    return validProfiles
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
export const profileAgent = new ProfileAgent()
