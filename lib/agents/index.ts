/**
 * lib/agents/index.ts
 * Barrel export — import agents from "@/lib/agents" in the QStash route.
 */

export { summaryAgent, SummaryAgent } from "./summary-agent"
export type { ExecutiveSummary, ActionItem, SummaryAgentOutput } from "./summary-agent"

export { riskAgent, RiskAgent } from "./risk-agent"
export type { RiskAnalysisResult } from "./risk-agent"

export { sentimentAgent, SentimentAgent } from "./sentiment-agent"
export type { SentimentDataPoint } from "./sentiment-agent"

export { profileAgent, ProfileAgent } from "./profile-agent"
export type { SpeakerProfile, SpeakerProfiles } from "./profile-agent"

// Base class + shared utilities re-exported for advanced consumers.
export {
  BaseAgent,
  buildCacheKey,
  getCachedOrGenerate,
  isAlreadyCompleted,
  markCompleted,
  normalizeTranscript,
  truncateTranscript,
  validateTranscript,
  parseAgentJSON,
  MODEL,
  CACHE_TTL_SECONDS,
} from "./base-agent"
