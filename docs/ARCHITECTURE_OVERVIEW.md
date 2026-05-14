# ARCHITECTURE OVERVIEW

## 1. Service Map & Dependency Graph

### Core Infrastructure
- **Framework:** Next.js 15 (App Router)
- **Database (Relational):** PostgreSQL (Neon) via Prisma ORM (`lib/db.ts`)
- **Database (Vector):** Pinecone (`lib/pinecone.ts`)
- **Database (Graph):** Neo4j (`lib/graph.ts`)
- **Caching & Rate Limiting:** Upstash Redis (`lib/ratelimit.ts`, `lib/ai-processor.ts`)
- **Asynchronous Queue:** Upstash QStash (`app/api/queue/process-meeting/route.ts`)
- **LLM Provider:** Groq (Llama-3.3-70b-versatile & Llama-3.1-8b-instant)

### Key Dependencies
- `MeetingBaas` / Webhooks: Ingests raw meeting transcripts.
- `@upstash/qstash`: Fan-out background job execution.
- `@langchain/community`: Used primarily for Neo4j graph extraction and manipulation.

---

## 2. Ingestion Lifecycle (Async Pipeline)

When a meeting webhook fires (presumably from MeetingBaas to `app/api/webhooks/meetingbaas/route.ts`), it triggers an asynchronous fan-out process using QStash. 

The QStash messages are routed to `app/api/queue/process-meeting/route.ts` with a specific `taskType`. The pipeline runs these isolated tasks independently:

1. **SUMMARY Task:** 
   - Generates executive summary & action items (`processMeetingTranscript`).
   - Emails the summary (`sendMeetingSummaryEmail`).
   - Persists to DB and triggers the Vector RAG ingestion (`processTranscript`), which uses parent-child chunking.
2. **RISK Task:** Extracts risk analysis and blind spots.
3. **SENTIMENT Task:** Analyases timeline-based sentiment shifts.
4. **PROFILES Task:** Generates behavioral profiles for speakers.
5. **GRAPH Task:** Extracts entities (`Speaker`, `Project`, `ActionItem`, etc.) and pushes them to Neo4j (`addToKnowledgeGraph`).

---

## 3. Retrieval Lifecycle

The current retrieval system is fragmented but powerful:

- **Vector (Semantic) Retrieval:** `lib/rag.ts` handles hybrid Pinecone + Neo4j lookups. Pinecone uses a parent-child chunking mechanism (retrieves the 100-token child, returns the 500-token parent).
- **Graph Retrieval:** `lib/graph.ts` has a hardcoded intent-router (`detectIntent`) that routes questions to specific Cypher queries (e.g., `PERSON`, `PROJECT`, `MEETING`).
- **Keyword Retrieval:** A `bm25.ts` file exists but is not yet fully integrated into a unified hybrid retriever.
- **Reranking:** `lib/reranker.ts` exists but needs to be woven into the core `rag.ts` pipeline.

---

## 4. Failure Points & Scaling Bottlenecks

### Queue Reliability
- **Idempotency:** QStash retries on 500s. However, `app/api/queue/process-meeting/route.ts` does not explicitly check if a `taskType` was already successfully completed before running it again, which could lead to duplicated emails or duplicate Neo4j nodes if an edge-case retry occurs.
- **Legacy Fallback:** If `taskType` is missing, the route defaults to a monolithic `Promise.allSettled` block. If the server times out during this heavy block, all jobs fail silently without fine-grained retries.

### Database Constraints
- **NeonDB Connections:** Heavy parallel processing from QStash can exhaust Serverless Postgres connections if not pooled correctly.
- **Redis Overload:** Caching logic in `ai-processor.ts` hashes entire transcripts as cache keys. Very large transcripts might bloat Redis quickly.

### Graph & Memory Constraints
- **Node/Edge Explosion:** `graph.ts` currently creates `MENTIONED_IN` edges without temporal decay. Over 100 meetings, a single `Project` node will have 100+ edges, causing Cypher query performance to degrade and context windows to explode when querying.
- **Hallucination Risk:** The Neo4j intent-router relies on a fast LLM (`llama-3.1-8b`) to extract `entityName`. If the LLM hallucinates the entity name, the Cypher query will return empty.

---

## 5. Observability Gaps

- Sentry is installed, but the background QStash workers lack fine-grained distributed tracing (e.g., tracing a webhook all the way through the 5 isolated QStash jobs).
- No metrics on Graph vs. Vector retrieval accuracy.
- No dead-letter queue (DLQ) alerts configured for failed QStash messages.
