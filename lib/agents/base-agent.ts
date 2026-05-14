/**
 * BASE AGENT ARCHITECTURE
 * Phase 3.1 — Multi-Agent Orchestration
 *
 * Provides:
 *  - Groq model invocation (llama-3.3-70b-versatile)
 *  - Robust JSON extraction + auto-repair from LLM responses
 *  - Redis-backed idempotency checks to survive QStash retries
 *  - Deterministic cache-key generation (SHA-256 of input)
 *  - Cache-aside get-or-generate pattern with non-fatal fallback
 */

import Groq from "groq-sdk"
import { Redis } from "@upstash/redis"
import { createHash } from "crypto"

// ─── Shared infrastructure (single instances, module-level singletons) ────────

export const groq = new Groq( { apiKey: process.env.GROQ_API_KEY! } )
export const redis = Redis.fromEnv()

export const MODEL = "llama-3.3-70b-versatile"

/** Cache TTL: 7 days. Transcripts are immutable once recorded. */
export const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type AgentRunOptions = {
  /** The unique meeting identifier — used for idempotency key namespacing. */
  meetingId: string
  /** Raw transcript, any supported shape. */
  transcript: unknown
}

export type GroqCallOptions = {
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Builds a deterministic Redis key from a task label and raw input payload.
 * Uses SHA-256 so the key is stable regardless of JSON key ordering.
 *
 * Format:  `ai:<task>:<32-char-hex>`
 */
export function buildCacheKey ( task: string, input: unknown ): string
{
  const hash = createHash( "sha256" )
    .update( JSON.stringify( input ) )
    .digest( "hex" )
    .slice( 0, 32 )
  return `ai:${ task }:${ hash }`
}

/**
 * Cache-aside wrapper.
 *
 * 1. Checks Redis for a cached result keyed by `task + content hash`.
 * 2. Hit  → returns cached value instantly; Groq is never called.
 * 3. Miss → runs `generatorFn`, persists result, returns it.
 *
 * Redis errors are non-fatal: the generator is always called as a fallback
 * so a cache outage never breaks AI processing.
 */
export async function getCachedOrGenerate<T> (
  task: string,
  input: unknown,
  generatorFn: () => Promise<T>
): Promise<T>
{
  const key = buildCacheKey( task, input )

  try
  {
    const cached = await redis.get<T>( key )
    if ( cached !== null && cached !== undefined )
    {
      console.log( `✅ Cache hit  [${ task }] key=…${ key.slice( -8 ) }` )
      return cached
    }
  } catch ( err )
  {
    console.warn( `⚠️  Redis GET failed [${ task }] — falling through to Groq:`, err )
  }

  console.log( `🔄 Cache miss [${ task }] — calling Groq…` )
  const result = await generatorFn()

  try
  {
    await redis.set( key, result, { ex: CACHE_TTL_SECONDS } )
    console.log( `💾 Cached     [${ task }] key=…${ key.slice( -8 ) } ttl=${ CACHE_TTL_SECONDS }s` )
  } catch ( err )
  {
    console.warn( `⚠️  Redis SET failed [${ task }]:`, err )
  }

  return result
}

// ─── JSON parsing & repair ────────────────────────────────────────────────────

/**
 * Attempts to extract valid JSON from a raw LLM response.
 *
 * Strategy (most-to-least permissive):
 *  1. Strip markdown fences and parse directly.
 *  2. Extract the first `{…}` block and parse.
 *  3. Extract the first `[…]` block and parse.
 *  4. Throw a descriptive error.
 *
 * After parsing, optionally validates that `expectedFields` are present.
 */
export function parseAgentJSON<T extends Record<string, unknown>> (
  content: string | null | undefined,
  expectedFields?: ( keyof T )[]
): T
{
  if ( !content ) throw new Error( "EMPTY_LLM_RESPONSE" )

  // Strip markdown fences
  const stripped = content
    .replace( /^```(?:json)?\s*/im, "" )
    .replace( /```\s*$/im, "" )
    .trim()

  // Attempt 1 — direct parse
  let parsed: T | undefined
  try
  {
    parsed = JSON.parse( stripped ) as T
  } catch ( _directErr )
  {
    // Attempt 2 — find first {...}
    const objMatch = stripped.match( /\{[\s\S]*\}/ )
    if ( objMatch )
    {
      try
      {
        parsed = JSON.parse( objMatch[ 0 ] ) as T
      } catch { /* fall through */ }
    }

    // Attempt 3 — find first [...]
    if ( !parsed )
    {
      const arrMatch = stripped.match( /\[[\s\S]*\]/ )
      if ( arrMatch )
      {
        try
        {
          parsed = JSON.parse( arrMatch[ 0 ] ) as T
        } catch { /* fall through */ }
      }
    }

    if ( !parsed )
    {
      throw new Error( `JSON_PARSE_FAILED: could not extract JSON from: ${ stripped.slice( 0, 200 ) }` )
    }
  }

  if ( expectedFields )
  {
    const missing = expectedFields.filter( ( f ) => !( f in parsed! ) )
    if ( missing.length > 0 )
    {
      throw new Error( `MISSING_FIELDS: ${ String( missing.join( ", " ) ) }` )
    }
  }

  return parsed
}

// ─── Transcript normalisation (shared across all agents) ──────────────────────

/**
 * Normalises a transcript from any supported shape into a plain string.
 * Supported shapes:
 *  - `string`                       → used as-is
 *  - `Array<{ speaker, words|text }>` → formatted as "Speaker: text\n…"
 *  - `{ text: string }`             → text field extracted
 */
export function normalizeTranscript ( transcript: unknown ): string
{
  if ( typeof transcript === "string" ) return transcript.trim()

  if ( Array.isArray( transcript ) )
  {
    return transcript
      .map( ( item: unknown ) =>
      {
        const seg = item as Record<string, unknown>
        const text =
          Array.isArray( seg.words ) && seg.words.length > 0
            ? ( seg.words as unknown[] )
              .map( ( w ) => String( ( w as Record<string, unknown> ).word ?? "" ) )
              .join( " " )
            : String( seg.text ?? "[speaking]" )
        return `${ String( seg.speaker ?? "Speaker" ) }: ${ text }`
      } )
      .join( "\n" )
  }

  if ( transcript && typeof transcript === "object" && "text" in transcript )
  {
    return String( ( transcript as Record<string, unknown> ).text ).trim()
  }

  throw new Error( "INVALID_TRANSCRIPT_FORMAT" )
}

/**
 * Hard-limits a transcript to `maxLength` characters, breaking at the last
 * newline that falls within the final 20 % of the allowed range.
 */
export function truncateTranscript ( text: string, maxLength: number ): string
{
  if ( text.length <= maxLength ) return text
  const cut = text.substring( 0, maxLength )
  const lastNl = cut.lastIndexOf( "\n" )
  return lastNl > maxLength * 0.8 ? cut.substring( 0, lastNl ) : cut
}

/** Returns `{ valid, error? }`. Rejects empty, trivial, or oversized transcripts. */
export function validateTranscript (
  text: string,
  maxLength: number
): { valid: boolean; error?: string }
{
  if ( !text || text.length === 0 ) return { valid: false, error: "EMPTY_TRANSCRIPT" }
  if ( text.length > maxLength )
    return { valid: false, error: `TRANSCRIPT_TOO_LONG: ${ text.length }/${ maxLength }` }
  const meaningful = text.replace( /[^a-zA-Z0-9\s]/g, "" ).trim()
  if ( meaningful.length < 20 ) return { valid: false, error: "INSUFFICIENT_CONTENT" }
  return { valid: true }
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

/**
 * Checks whether a given agent task has already been completed for a meeting.
 *
 * Uses a lightweight Redis key `idempotency:<task>:<meetingId>` that is
 * written by each agent after it successfully persists its result to the DB.
 * This survives QStash retries: if Groq succeeded but the DB write failed,
 * the idempotency key is NOT set, so the agent retries the full flow.
 */
export async function isAlreadyCompleted (
  task: string,
  meetingId: string
): Promise<boolean>
{
  try
  {
    const key = `idempotency:${ task }:${ meetingId }`
    const val = await redis.get<string>( key )
    if ( val )
    {
      console.log( `⏭️  Idempotency hit [${ task }] meeting=${ meetingId } — skipping` )
      return true
    }
    return false
  } catch ( err )
  {
    // Non-fatal: if Redis is down, proceed and let the task run again.
    console.warn( `⚠️  Idempotency check failed [${ task }]:`, err )
    return false
  }
}

/**
 * Marks a task as completed in Redis.
 * TTL matches the transcript cache TTL so keys self-clean together.
 */
export async function markCompleted (
  task: string,
  meetingId: string
): Promise<void>
{
  try
  {
    const key = `idempotency:${ task }:${ meetingId }`
    await redis.set( key, new Date().toISOString(), { ex: CACHE_TTL_SECONDS } )
    console.log( `🔒 Marked complete [${ task }] meeting=${ meetingId }` )
  } catch ( err )
  {
    console.warn( `⚠️  markCompleted failed [${ task }]:`, err )
  }
}

// ─── Abstract Base Agent ──────────────────────────────────────────────────────

/**
 * `BaseAgent<TOutput>` — the contract every specialised agent must satisfy.
 *
 * Subclasses implement:
 *  - `taskName`   — stable identifier used in cache & idempotency keys
 *  - `execute()`  — core processing logic (Groq call + DB persist)
 *
 * The `run()` method wraps `execute()` with idempotency checking and
 * top-level error handling so the QStash route stays clean.
 */
export abstract class BaseAgent<TOutput>
{
  /** Stable identifier for this agent (e.g. "risk_analysis"). */
  abstract readonly taskName: string

  /**
   * Core logic: call Groq, parse the result, persist to DB.
   * Implementations should use `getCachedOrGenerate` internally.
   */
  protected abstract execute ( options: AgentRunOptions ): Promise<TOutput>

  /**
   * Public entry-point called by the QStash route.
   *
   * 1. Checks the idempotency key — returns early if already done.
   * 2. Calls `execute()`.
   * 3. Marks the task complete on success.
   * 4. Catches & logs errors without propagating (returns `null`).
   *
   * Note: `markCompleted` is only called when `execute()` resolves,
   * meaning a partial failure (e.g. DB write error inside `execute`)
   * that throws will correctly allow a retry.
   */
  async run ( options: AgentRunOptions ): Promise<TOutput | null>
  {
    const { meetingId } = options

    if ( await isAlreadyCompleted( this.taskName, meetingId ) )
    {
      // Cast: callers treat `null` as "already done / no new output".
      return null
    }

    try
    {
      const result = await this.execute( options )
      await markCompleted( this.taskName, meetingId )
      return result
    } catch ( err )
    {
      console.error( `❌ Agent [${ this.taskName }] failed — meeting ${ meetingId }:`, err )
      // Re-throw so the QStash route returns 500 and triggers a retry.
      throw err
    }
  }

  // ── Protected helpers (available to all subclasses) ──────────────────────

  /** Thin wrapper: call Groq with `response_format: json_object`. */
  protected async callGroq ( options: GroqCallOptions ): Promise<string>
  {
    const response = await groq.chat.completions.create( {
      model: MODEL,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      response_format: { type: "json_object" },
      messages: options.messages,
    } )
    const content = response.choices[ 0 ]?.message?.content
    if ( !content ) throw new Error( "GROQ_EMPTY_RESPONSE" )
    return content
  }

  /** Re-exported for convenience inside subclasses. */
  protected getCachedOrGenerate = getCachedOrGenerate
  protected parseJSON = parseAgentJSON
  protected normalize = normalizeTranscript
  protected truncate = truncateTranscript
  protected validate = validateTranscript
}
