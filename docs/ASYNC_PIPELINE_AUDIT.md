# ASYNC PIPELINE AUDIT

## 1. Orchestration Flow
- Driven by **Upstash QStash** pointing to `app/api/queue/process-meeting/route.ts`.
- Implements a Fan-Out pattern using `taskType`: `SUMMARY`, `RISK`, `SENTIMENT`, `PROFILES`, `GRAPH`.

## 2. Failure Recovery & Retry Flows
- **QStash Retries:** QStash automatically retries requests that return a `500` status code. The code catches errors and returns a `500`, properly utilizing this feature.
- **Idempotency Gaps:** The database updates (e.g., `await prisma.meeting.update({ ... processed: true })`) are not checked *before* execution. If QStash retries a `SUMMARY` task that failed during the email-sending step, it will regenerate the Groq summary and overwrite the DB again.
- **Legacy Handler:** There is a monolithic fallback for jobs missing a `taskType`. This runs a massive `Promise.allSettled`. If this times out (e.g., Vercel 10s-60s limit), the job fails and QStash retries the *entire* heavy block, risking infinite loops and high LLM costs.

## 3. Concurrency & Race Conditions
- The `SUMMARY` task writes the processed text to the DB, and then triggers `processTranscript` (Pinecone ingestion). Meanwhile, `GRAPH` is running concurrently. There are no direct race conditions on database row locks, but they both heavily hit Groq concurrently.
- **Rate Limiting:** Fanning out 5 heavy LLM tasks simultaneously per meeting could easily trigger Groq API rate limits (`429 Too Many Requests`). The current pipeline lacks a backoff strategy for LLM 429 errors.
