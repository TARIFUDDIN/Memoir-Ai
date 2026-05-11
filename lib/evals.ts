/**
 * lib/evals.ts — Phase 4: Ragas-style evaluation harness
 *
 * Implements 4 metrics via Groq LLM-as-judge (no Python/Ragas needed):
 * - Faithfulness:      are answer claims grounded in retrieved contexts?
 * - Answer Relevancy:  does the answer address the question?
 * - Context Precision: were retrieved chunks actually useful?
 * - Context Recall:    did contexts cover the ground truth?
 *
 * Pass gate uses a weighted composite score (same logic as ragas_score):
 *   score = faithfulness×0.35 + answerRelevancy×0.35 + precision×0.15 + recall×0.15
 */

import Groq from "groq-sdk"
import { chatWithAllMeetings } from "./rag"

const groq = new Groq( { apiKey: process.env.GROQ_API_KEY! } )
const FAST_MODEL = "llama-3.1-8b-instant"
const SMART_MODEL = "llama-3.3-70b-versatile"

// Composite score weights — must sum to 1.0
const WEIGHTS = {
  faithfulness: 0.35,
  answerRelevancy: 0.35,
  contextPrecision: 0.15,
  contextRecall: 0.15,
} as const

const PASS_THRESHOLD = 0.70

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvalQuestion = {
  id: string
  question: string
  ground_truth: string
  expected_sources?: string[]
  category: "DECISION" | "ACTION_ITEM" | "PERSON" | "PROJECT" | "TOPIC" | "FACTUAL"
}

export type EvalResult = {
  questionId: string
  question: string
  answer: string
  groundTruth: string
  contexts: string[]
  faithfulness: number
  answerRelevancy: number
  contextPrecision: number
  contextRecall: number
  compositeScore: number   // ← weighted aggregate (new)
  passed: boolean
  latencyMs: number
  category: string
  fromCache: boolean
}

// Category-level aggregation (new)
export type CategoryStats = {
  category: string
  count: number
  passRate: number
  avgCompositeScore: number
  avgFaithfulness: number
  avgAnswerRelevancy: number
  avgContextPrecision: number
  avgContextRecall: number
}

export type EvalRunSummary = {
  runId: string
  timestamp: string
  totalQuestions: number
  passedQuestions: number
  passRate: number
  avgFaithfulness: number
  avgAnswerRelevancy: number
  avgContextPrecision: number
  avgContextRecall: number
  avgCompositeScore: number   // ← new
  avgLatencyMs: number
  byCategory: CategoryStats[] // ← new
  results: EvalResult[]
}

// ---------------------------------------------------------------------------
// Retry helper — Groq 429s are common on the free tier
// ---------------------------------------------------------------------------

async function withRetry<T> (
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000
): Promise<T>
{
  let lastErr: unknown
  for ( let attempt = 0; attempt < retries; attempt++ )
  {
    try
    {
      return await fn()
    } catch ( err: unknown )
    {
      lastErr = err
      const isRateLimit =
        err instanceof Error &&
        ( err.message.includes( "429" ) || err.message.toLowerCase().includes( "rate limit" ) )
      if ( !isRateLimit || attempt === retries - 1 ) throw err
      // Exponential back-off: 1 s, 2 s, 4 s
      await new Promise( ( r ) => setTimeout( r, baseDelayMs * Math.pow( 2, attempt ) ) )
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Shared JSON parser — strips markdown fences, validates shape
// ---------------------------------------------------------------------------

function parseJson<T> ( raw: string, fallback: T ): T
{
  try
  {
    const clean = raw.replace( /```json|```/g, "" ).trim()
    return JSON.parse( clean ) as T
  } catch
  {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Metric 1: Faithfulness
// Decompose the answer into atomic claims first, then verify each one.
// Two-step approach is significantly more reliable than asking for a count.
// ---------------------------------------------------------------------------

async function scoreFaithfulness (
  answer: string,
  contexts: string[]
): Promise<number>
{
  if ( !answer.trim() || contexts.length === 0 ) return 0

  const contextText = contexts.map( ( c, i ) => `[${ i + 1 }] ${ c }` ).join( "\n\n" )

  return withRetry( async () =>
  {
    // Step 1: extract atomic claims from the answer
    const claimsRes = await groq.chat.completions.create( {
      model: FAST_MODEL,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract every distinct factual claim from the answer as a JSON array.
Return ONLY: { "claims": ["claim 1", "claim 2", ...] }
Keep each claim short and self-contained. If the answer has no verifiable claims, return { "claims": [] }.`,
        },
        { role: "user", content: `Answer: ${ answer }` },
      ],
    } )

    const { claims = [] } = parseJson<{ claims: string[] }>(
      claimsRes.choices[ 0 ]?.message?.content ?? "{}",
      { claims: [] }
    )
    if ( claims.length === 0 ) return 0

    // Step 2: verify each claim against the contexts
    const verifications = await Promise.all(
      claims.map( async ( claim ) =>
      {
        const res = await groq.chat.completions.create( {
          model: FAST_MODEL,
          temperature: 0,
          max_tokens: 60,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Is the claim supported by the provided contexts?
Return ONLY: { "supported": true } or { "supported": false }`,
            },
            {
              role: "user",
              content: `Contexts:\n${ contextText }\n\nClaim: ${ claim }`,
            },
          ],
        } )
        const { supported = false } = parseJson<{ supported: boolean }>(
          res.choices[ 0 ]?.message?.content ?? "{}",
          { supported: false }
        )
        return supported
      } )
    )

    const supportedCount = verifications.filter( Boolean ).length
    return supportedCount / claims.length
  } )
}

// ---------------------------------------------------------------------------
// Metric 2: Answer Relevancy
// Does the answer actually address the question?
// ---------------------------------------------------------------------------

async function scoreAnswerRelevancy (
  question: string,
  answer: string
): Promise<number>
{
  if ( !answer.trim() ) return 0

  return withRetry( async () =>
  {
    const res = await groq.chat.completions.create( {
      model: FAST_MODEL,
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Score how directly and completely the answer addresses the question.
Return ONLY: { "score": <0.0–1.0>, "reason": "<one sentence>" }
1.0 = perfectly on-point. 0.0 = completely off-topic or empty.`,
        },
        {
          role: "user",
          content: `Question: ${ question }\n\nAnswer: ${ answer }`,
        },
      ],
    } )

    const { score = 0 } = parseJson<{ score: number }>(
      res.choices[ 0 ]?.message?.content ?? "{}",
      { score: 0 }
    )
    return Math.min( 1, Math.max( 0, Number( score ) ) )
  } )
}

// ---------------------------------------------------------------------------
// Metric 3: Context Precision
// Of the retrieved chunks, how many were actually useful?
// ---------------------------------------------------------------------------

async function scoreContextPrecision (
  question: string,
  contexts: string[],
  groundTruth: string
): Promise<number>
{
  if ( contexts.length === 0 ) return 0

  return withRetry( async () =>
  {
    const usefulFlags = await Promise.all(
      contexts.map( async ( chunk ) =>
      {
        const res = await groq.chat.completions.create( {
          model: FAST_MODEL,
          temperature: 0,
          max_tokens: 60,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Was this context chunk useful for answering the question, given the ground truth?
Return ONLY: { "useful": true } or { "useful": false }`,
            },
            {
              role: "user",
              content: `Question: ${ question }\nGround truth: ${ groundTruth }\nContext: ${ chunk.substring( 0, 400 ) }`,
            },
          ],
        } )
        const { useful = false } = parseJson<{ useful: boolean }>(
          res.choices[ 0 ]?.message?.content ?? "{}",
          { useful: false }
        )
        return useful
      } )
    )

    return usefulFlags.filter( Boolean ).length / contexts.length
  } )
}

// ---------------------------------------------------------------------------
// Metric 4: Context Recall
// Did the retrieved contexts cover what the ground truth requires?
// Uses SMART_MODEL — needs more reasoning capacity.
// ---------------------------------------------------------------------------

async function scoreContextRecall (
  groundTruth: string,
  contexts: string[]
): Promise<number>
{
  if ( contexts.length === 0 || !groundTruth.trim() ) return 0

  const contextText = contexts.map( ( c, i ) => `[${ i + 1 }] ${ c }` ).join( "\n\n" )

  return withRetry( async () =>
  {
    const res = await groq.chat.completions.create( {
      model: SMART_MODEL,
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Estimate what fraction of the ground truth information is covered by the retrieved contexts.
Return ONLY: { "score": <0.0–1.0>, "reason": "<one sentence>" }
1.0 = contexts fully cover the ground truth. 0.0 = no coverage at all.`,
        },
        {
          role: "user",
          content: `Ground truth: ${ groundTruth }\n\nContexts:\n${ contextText }`,
        },
      ],
    } )

    const { score = 0 } = parseJson<{ score: number }>(
      res.choices[ 0 ]?.message?.content ?? "{}",
      { score: 0 }
    )
    return Math.min( 1, Math.max( 0, Number( score ) ) )
  } )
}

// ---------------------------------------------------------------------------
// Composite score helper
// ---------------------------------------------------------------------------

function computeCompositeScore (
  faithfulness: number,
  answerRelevancy: number,
  contextPrecision: number,
  contextRecall: number
): number
{
  return (
    faithfulness * WEIGHTS.faithfulness +
    answerRelevancy * WEIGHTS.answerRelevancy +
    contextPrecision * WEIGHTS.contextPrecision +
    contextRecall * WEIGHTS.contextRecall
  )
}

// ---------------------------------------------------------------------------
// Single question evaluator
// ---------------------------------------------------------------------------

async function evaluateQuestion (
  evalQ: EvalQuestion,
  userId: string
): Promise<EvalResult>
{
  const startMs = Date.now()

  const ragResult = await chatWithAllMeetings( userId, evalQ.question )

  const answer = ragResult.answer ?? ""
  const contexts = ( ragResult.sources ?? [] )
    .map( ( s ) => String( s.content ?? "" ) )
    .filter( Boolean )
  const fromCache = ragResult.fromCache ?? false

  // All 4 metrics in parallel — each already has its own retry wrapper
  const [ faithfulness, answerRelevancy, contextPrecision, contextRecall ] =
    await Promise.all( [
      scoreFaithfulness( answer, contexts ),
      scoreAnswerRelevancy( evalQ.question, answer ),
      scoreContextPrecision( evalQ.question, contexts, evalQ.ground_truth ),
      scoreContextRecall( evalQ.ground_truth, contexts ),
    ] )

  const compositeScore = computeCompositeScore(
    faithfulness, answerRelevancy, contextPrecision, contextRecall
  )
  const passed = compositeScore >= PASS_THRESHOLD

  return {
    questionId: evalQ.id,
    question: evalQ.question,
    answer,
    groundTruth: evalQ.ground_truth,
    contexts,
    faithfulness,
    answerRelevancy,
    contextPrecision,
    contextRecall,
    compositeScore,
    passed,
    latencyMs: Date.now() - startMs,
    category: evalQ.category,
    fromCache,
  }
}

// ---------------------------------------------------------------------------
// Category aggregation helper
// ---------------------------------------------------------------------------

function aggregateByCategory ( results: EvalResult[] ): CategoryStats[]
{
  const groups = new Map<string, EvalResult[]>()

  for ( const r of results )
  {
    const list = groups.get( r.category ) ?? []
    list.push( r )
    groups.set( r.category, list )
  }

  const avg = ( arr: EvalResult[], key: keyof EvalResult ) =>
    arr.reduce( ( s, r ) => s + Number( r[ key ] ?? 0 ), 0 ) / arr.length

  return Array.from( groups.entries() )
    .sort( ( [ a ], [ b ] ) => a.localeCompare( b ) )
    .map( ( [ category, arr ] ) => ( {
      category,
      count: arr.length,
      passRate: arr.filter( ( r ) => r.passed ).length / arr.length,
      avgCompositeScore: avg( arr, "compositeScore" ),
      avgFaithfulness: avg( arr, "faithfulness" ),
      avgAnswerRelevancy: avg( arr, "answerRelevancy" ),
      avgContextPrecision: avg( arr, "contextPrecision" ),
      avgContextRecall: avg( arr, "contextRecall" ),
    } ) )
}

// ---------------------------------------------------------------------------
// Full eval run — sequential to avoid Groq rate limits
// ---------------------------------------------------------------------------

export async function runEvals (
  userId: string,
  dataset: EvalQuestion[],
  onProgress?: ( completed: number, total: number, latest: EvalResult ) => void
): Promise<EvalRunSummary>
{
  const runId = `run_${ Date.now() }`
  const results: EvalResult[] = []

  console.log( `🧪 Starting eval run [${ runId }]: ${ dataset.length } questions` )

  for ( let i = 0; i < dataset.length; i++ )
  {
    const q = dataset[ i ]
    console.log( `📋 [${ i + 1 }/${ dataset.length }] ${ q.category } — ${ q.question }` )

    try
    {
      const result = await evaluateQuestion( q, userId )
      results.push( result )
      onProgress?.( i + 1, dataset.length, result )
      console.log(
        `  ${ result.passed ? "✅" : "❌" } ` +
        `composite=${ result.compositeScore.toFixed( 2 ) } | ` +
        `F=${ result.faithfulness.toFixed( 2 ) } ` +
        `AR=${ result.answerRelevancy.toFixed( 2 ) } ` +
        `CP=${ result.contextPrecision.toFixed( 2 ) } ` +
        `CR=${ result.contextRecall.toFixed( 2 ) } ` +
        `(${ result.latencyMs }ms${ result.fromCache ? ", cached" : "" })`
      )
    } catch ( err )
    {
      console.error(
        `  ❌ Question ${ q.id } failed:`,
        err instanceof Error ? err.message : err
      )
    }

    // Breathing room between questions — Groq free tier is generous but not unlimited
    if ( i < dataset.length - 1 )
    {
      await new Promise( ( r ) => setTimeout( r, 500 ) )
    }
  }

  if ( results.length === 0 )
  {
    throw new Error( "Eval run produced zero results — check RAG pipeline and Groq API key" )
  }

  const avg = ( key: keyof EvalResult ) =>
    results.reduce( ( s, r ) => s + Number( r[ key ] ?? 0 ), 0 ) / results.length

  const summary: EvalRunSummary = {
    runId,
    timestamp: new Date().toISOString(),
    totalQuestions: results.length,
    passedQuestions: results.filter( ( r ) => r.passed ).length,
    passRate: results.filter( ( r ) => r.passed ).length / results.length,
    avgFaithfulness: avg( "faithfulness" ),
    avgAnswerRelevancy: avg( "answerRelevancy" ),
    avgContextPrecision: avg( "contextPrecision" ),
    avgContextRecall: avg( "contextRecall" ),
    avgCompositeScore: avg( "compositeScore" ),
    avgLatencyMs: avg( "latencyMs" ),
    byCategory: aggregateByCategory( results ),
    results,
  }

  // Pretty summary log
  console.log( `\n🏁 Eval run complete — ${ runId }` )
  console.log( `   Questions : ${ summary.passedQuestions }/${ summary.totalQuestions } passed (${ ( summary.passRate * 100 ).toFixed( 0 ) }%)` )
  console.log( `   Composite : ${ summary.avgCompositeScore.toFixed( 3 ) }` )
  console.log( `   Faithfulness   : ${ summary.avgFaithfulness.toFixed( 3 ) }` )
  console.log( `   Ans Relevancy  : ${ summary.avgAnswerRelevancy.toFixed( 3 ) }` )
  console.log( `   Ctx Precision  : ${ summary.avgContextPrecision.toFixed( 3 ) }` )
  console.log( `   Ctx Recall     : ${ summary.avgContextRecall.toFixed( 3 ) }` )
  console.log( `   Avg latency    : ${ Math.round( summary.avgLatencyMs ) }ms` )

  if ( summary.byCategory.length > 1 )
  {
    console.log( `\n   By category:` )
    for ( const cat of summary.byCategory )
    {
      console.log(
        `     ${ cat.category.padEnd( 12 ) } ` +
        `pass=${ ( cat.passRate * 100 ).toFixed( 0 ).padStart( 3 ) }%  ` +
        `composite=${ cat.avgCompositeScore.toFixed( 2 ) }`
      )
    }
  }

  return summary
}