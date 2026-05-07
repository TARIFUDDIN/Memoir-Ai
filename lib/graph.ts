/**
 * lib/graph.ts — Phase 3: Deep GraphRAG
 *
 * Changes from Phase 2:
 * 3a. queryGraphMemory — replaced GraphCypherQAChain with intent-based explicit Cypher routing
 * 3b. addToKnowledgeGraph — cross-meeting MERGE so shared entities (projects, topics, people)
 *     become shared nodes across meetings instead of isolated per-meeting duplicates
 * 3c. Co-reference resolution — fuzzy name merge via Groq before writing to Neo4j
 */

import { Neo4jGraph } from "@langchain/community/graphs/neo4j_graph"
import Groq from "groq-sdk"
import {
  enrichTranscript,
  normalizeName,
  type ExtractedEntity,
} from "./entity-extractor"

// ---------------------------------------------------------------------------
// Groq client (replaces ChatOpenAI shim — used for intent detection + coref)
// ---------------------------------------------------------------------------
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })
const FAST_MODEL = "llama-3.1-8b-instant"
const SMART_MODEL = "llama-3.3-70b-versatile"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GraphNode = {
  type: string
  id: string
  properties: Record<string, unknown>
}

type GraphRelationship = {
  source: string
  target: string
  type: string
  properties?: Record<string, unknown>
}

type KnowledgeGraphData = {
  nodes: GraphNode[]
  relationships: GraphRelationship[]
  meetingId: string
  extractedAt: Date
}

type QueryIntent =
  | "PERSON"
  | "PROJECT"
  | "TOPIC"
  | "ACTION_ITEM"
  | "MEETING"
  | "GENERAL"

type IntentResult = {
  intent: QueryIntent
  entityName: string | null
  normalizedId: string | null
}

// ---------------------------------------------------------------------------
// Neo4j singleton
// ---------------------------------------------------------------------------

let graphInstance: Neo4jGraph | null = null

async function getGraph(): Promise<Neo4jGraph> {
  if (graphInstance) return graphInstance
  const maxRetries = 3
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔗 Connecting to Neo4j (attempt ${attempt}/${maxRetries})...`)
      graphInstance = await Neo4jGraph.initialize({
        url: process.env.NEO4J_URI!,
        username: process.env.NEO4J_USERNAME!,
        password: process.env.NEO4J_PASSWORD!,
      })
      console.log("✅ Neo4j connection established")
      return graphInstance
    } catch (error) {
      console.error(`❌ Neo4j attempt ${attempt} failed:`, error instanceof Error ? error.message : error)
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)))
      }
    }
  }
  throw new Error("Failed to connect to Neo4j after retries")
}

// ---------------------------------------------------------------------------
// 3c. Co-reference resolution
// "Bob", "Bob Smith", "Mr Smith" → same canonical node
// ---------------------------------------------------------------------------

async function resolveCoReferences(
  entities: ExtractedEntity[]
): Promise<ExtractedEntity[]> {
  const people = entities.filter((e) => e.type === "PERSON")
  if (people.length < 2) return entities

  try {
    const nameList = people.map((p) => p.value).join(", ")
    const response = await groq.chat.completions.create({
      model: FAST_MODEL,
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a co-reference resolution engine. Given a list of person names from a meeting transcript, identify which names refer to the same person.
Return ONLY this JSON format — no explanation:
{
  "groups": [
    { "canonical": "Full Name", "aliases": ["alias1", "alias2"] }
  ]
}
Only include groups where 2+ names clearly refer to the same person. If all names are distinct people, return { "groups": [] }.`,
        },
        {
          role: "user",
          content: `Names from transcript: ${nameList}`,
        },
      ],
    })

    const content = response.choices[0]?.message?.content
    if (!content) return entities

    const parsed = JSON.parse(content.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim())
    const groups: Array<{ canonical: string; aliases: string[] }> = parsed.groups ?? []

    if (groups.length === 0) return entities

    // Build alias → canonical map
    const aliasToCanonical = new Map<string, string>()
    for (const group of groups) {
      const canonicalNorm = normalizeName(group.canonical)
      for (const alias of group.aliases) {
        aliasToCanonical.set(normalizeName(alias), canonicalNorm)
        aliasToCanonical.set(alias.toLowerCase().trim(), canonicalNorm)
      }
    }

    // Remap entities — merge aliases to canonical
    const seen = new Set<string>()
    const resolved: ExtractedEntity[] = []

    for (const entity of entities) {
      if (entity.type !== "PERSON") {
        resolved.push(entity)
        continue
      }
      const mapped = aliasToCanonical.get(entity.normalizedValue) ?? entity.normalizedValue
      if (seen.has(mapped)) continue
      seen.add(mapped)
      resolved.push({ ...entity, normalizedValue: mapped })
    }

    // Also fix assignedTo in ACTION_ITEMs
    return resolved.map((entity) => {
      if (entity.type !== "ACTION_ITEM") return entity
      const meta = entity.metadata as Record<string, unknown>
      if (!meta.assignedTo) return entity
      const remapped = aliasToCanonical.get(String(meta.assignedTo)) ?? String(meta.assignedTo)
      return { ...entity, metadata: { ...meta, assignedTo: remapped } }
    })
  } catch (err) {
    console.warn("⚠️ Co-reference resolution failed, proceeding without it:", err instanceof Error ? err.message : err)
    return entities
  }
}

// ---------------------------------------------------------------------------
// 3b. addToKnowledgeGraph — cross-meeting MERGE
// Shared entities (Project, Topic, Speaker) use MERGE on normalizedValue only,
// so the same entity appearing in multiple meetings shares one node.
// Meeting-specific entities (ActionItem, Decision) MERGE on id+meetingId.
// ---------------------------------------------------------------------------

export async function addToKnowledgeGraph(
  transcript: unknown,
  meetingId: string,
  meetingTitle: string,
  meetingStartTime?: Date
): Promise<KnowledgeGraphData | null> {
  try {
    if (!transcript) {
      console.warn("⚠️ Graph extraction skipped: No transcript provided")
      return null
    }

    console.log("🕸️ Starting Knowledge Graph Extraction (Phase 3)...")

    // -- Normalize transcript to text --
    let textContent = ""
    if (Array.isArray(transcript)) {
      textContent = transcript
        .map((t: unknown) => {
          const item = t as Record<string, unknown>
          const text =
            Array.isArray(item.words) && item.words.length > 0
              ? (item.words as unknown[]).map((w) => String((w as Record<string, unknown>).word ?? "")).join(" ")
              : String(item.text ?? "[speaking]")
          return `${String(item.speaker ?? "Speaker")}: ${text}`
        })
        .join("\n")
    } else if (typeof transcript === "string") {
      textContent = transcript
    } else if (transcript && typeof transcript === "object" && "text" in transcript) {
      textContent = String((transcript as Record<string, unknown>).text)
    }

    if (!textContent.trim()) throw new Error("EMPTY_TRANSCRIPT_CONTENT")

    // -- Extract entities --
    const enrichmentResult = await enrichTranscript(textContent)
    let entities = enrichmentResult.entities
    console.log(`✅ Extracted ${entities.length} raw entities`)

    // 3c — resolve co-references before writing
    entities = await resolveCoReferences(entities)
    console.log(`✅ After co-reference resolution: ${entities.length} entities`)

    const nodes: GraphNode[] = []
    const relationships: GraphRelationship[] = []

    // -- Meeting node (always per-meeting) --
    nodes.push({
      type: "Meeting",
      id: meetingId,
      properties: {
        id: meetingId,
        title: meetingTitle,
        meetingId,
        startTime: meetingStartTime?.toISOString() ?? new Date().toISOString(),
      },
    })

    // -- Process entities --
    for (const entity of entities) {

      // PERSON — shared node, cross-meeting via MERGE on normalizedValue
      if (entity.type === "PERSON") {
        nodes.push({
          type: "Speaker",
          id: entity.normalizedValue,
          properties: { id: entity.normalizedValue, name: entity.value },
          // NOTE: no meetingId on Speaker — intentionally shared
        })
        relationships.push({
          source: entity.normalizedValue,
          target: meetingId,
          type: "SPOKE_IN",
          properties: { meetingId },
        })
      }

      // ACTION_ITEM — scoped to meeting (unique per meeting)
      if (entity.type === "ACTION_ITEM") {
        const actionId = `${meetingId}_${entity.normalizedValue}`
        const meta = entity.metadata as Record<string, unknown>
        nodes.push({
          type: "ActionItem",
          id: actionId,
          properties: { id: actionId, text: entity.value, meetingId },
        })
        // ActionItem → MENTIONED_IN → Meeting (cross-meeting tracking)
        relationships.push({
          source: actionId,
          target: meetingId,
          type: "MENTIONED_IN",
          properties: { meetingId },
        })
        // ActionItem → ASSIGNED_TO → Speaker
        if (meta.assignedTo) {
          relationships.push({
            source: actionId,
            target: String(meta.assignedTo),
            type: "ASSIGNED_TO",
            properties: { meetingId },
          })
        }
        // ActionItem → HAS_DEADLINE → Deadline
        if (meta.deadline) {
          const deadlineId = `deadline_${String(meta.deadline).replace(/[^a-z0-9]/gi, "_")}`
          nodes.push({
            type: "Deadline",
            id: deadlineId,
            properties: { id: deadlineId, date: meta.deadline },
          })
          relationships.push({
            source: actionId,
            target: deadlineId,
            type: "HAS_DEADLINE",
            properties: { meetingId },
          })
        }
      }

      // DECISION — scoped to meeting
      if (entity.type === "DECISION") {
        const decisionId = `${meetingId}_${entity.normalizedValue}`
        nodes.push({
          type: "Decision",
          id: decisionId,
          properties: { id: decisionId, text: entity.value, meetingId },
        })
        relationships.push({
          source: meetingId,
          target: decisionId,
          type: "DECIDED_TO",
          properties: { meetingId },
        })
      }

      // PROJECT — shared node cross-meeting, MERGE on normalizedValue
      if (entity.type === "PROJECT") {
        nodes.push({
          type: "Project",
          id: entity.normalizedValue,
          properties: { id: entity.normalizedValue, name: entity.value },
          // No meetingId — shared across meetings
        })
        // Project → MENTIONED_IN → Meeting
        relationships.push({
          source: entity.normalizedValue,
          target: meetingId,
          type: "MENTIONED_IN",
          properties: { meetingId },
        })
      }

      // TOPIC — shared node cross-meeting
      if (entity.type === "TOPIC") {
        nodes.push({
          type: "Topic",
          id: entity.normalizedValue,
          properties: { id: entity.normalizedValue, name: entity.value },
        })
        relationships.push({
          source: meetingId,
          target: entity.normalizedValue,
          type: "DISCUSSED",
          properties: { meetingId },
        })
      }
    }

    // -- Write to Neo4j --
    const neo4j = await getGraph()

    for (const node of nodes) {
      await neo4j.query(
        `MERGE (n:${node.type} {id: $id}) SET n += $properties`,
        { id: node.id, properties: { ...node.properties, id: node.id } }
      )
    }

    for (const rel of relationships) {
      await neo4j.query(
        `MATCH (a {id: $sourceId})
         MATCH (b {id: $targetId})
         MERGE (a)-[r:${rel.type} {meetingId: $meetingId}]->(b)
         SET r += $properties`,
        {
          sourceId: rel.source,
          targetId: rel.target,
          meetingId: (rel.properties as Record<string, unknown>)?.meetingId ?? meetingId,
          properties: rel.properties ?? {},
        }
      )
    }

    // -- Cross-meeting CONTINUED_FROM links --
    // Link this meeting to the most recent prior meeting that shares a Project or Topic
    await neo4j.query(
      `MATCH (curr:Meeting {id: $meetingId})
       MATCH (prev:Meeting)
       WHERE prev.id <> $meetingId
         AND prev.startTime < curr.startTime
       MATCH (curr)<-[:MENTIONED_IN]-(shared)
       MATCH (shared)-[:MENTIONED_IN]->(prev)
       WITH curr, prev ORDER BY prev.startTime DESC LIMIT 1
       MERGE (curr)-[:CONTINUED_FROM]->(prev)`,
      { meetingId }
    )

    console.log(`🕸️ Phase 3 Graph Complete: ${nodes.length} nodes, ${relationships.length} relationships`)
    return { nodes, relationships, meetingId, extractedAt: new Date() }

  } catch (error) {
    console.error("❌ Knowledge Graph Extraction Failed:", error instanceof Error ? error.message : error)
    return null
  }
}

// ---------------------------------------------------------------------------
// 3a. Intent detection — Groq SDK directly, no ChatOpenAI shim
// ---------------------------------------------------------------------------

async function detectIntent(question: string): Promise<IntentResult> {
  try {
    const response = await groq.chat.completions.create({
      model: FAST_MODEL,
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Classify the intent of a question about meeting history.
Return ONLY this JSON:
{
  "intent": "PERSON" | "PROJECT" | "TOPIC" | "ACTION_ITEM" | "MEETING" | "GENERAL",
  "entityName": "the main entity name mentioned, or null"
}

Rules:
- PERSON: asks about a specific person ("what did Alice work on", "Bob's tasks")
- PROJECT: asks about a project ("Project Phoenix status", "what happened with the redesign")
- TOPIC: asks about a topic/theme ("what was discussed about security", "authentication meetings")
- ACTION_ITEM: asks about tasks/action items ("overdue tasks", "what actions are pending")
- MEETING: asks about specific meetings by date/time ("last week's meetings", "yesterday's call")
- GENERAL: anything else`,
        },
        { role: "user", content: question },
      ],
    })

    const content = response.choices[0]?.message?.content
    if (!content) return { intent: "GENERAL", entityName: null, normalizedId: null }

    const parsed = JSON.parse(content.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim())
    const entityName = parsed.entityName ?? null
    return {
      intent: (parsed.intent as QueryIntent) ?? "GENERAL",
      entityName,
      normalizedId: entityName ? normalizeName(String(entityName)) : null,
    }
  } catch {
    return { intent: "GENERAL", entityName: null, normalizedId: null }
  }
}

// ---------------------------------------------------------------------------
// Pre-written Cypher templates — one per intent
// ---------------------------------------------------------------------------

async function runPersonQuery(neo4j: Neo4jGraph, entityId: string): Promise<string> {
  const result = await neo4j.query(
    `MATCH (s:Speaker {id: $personId})
     OPTIONAL MATCH (s)-[:SPOKE_IN]->(m:Meeting)
     OPTIONAL MATCH (a:ActionItem)-[:ASSIGNED_TO]->(s)
     OPTIONAL MATCH (a)-[:HAS_DEADLINE]->(d:Deadline)
     RETURN
       s.name AS person,
       collect(DISTINCT m.title) AS meetings,
       collect(DISTINCT { action: a.text, deadline: d.date }) AS actions`,
    { personId: entityId }
  ) as Array<Record<string, unknown>>

  if (!result.length || !result[0].person) {
    return `No information found for person "${entityId}".`
  }

  const row = result[0]
  const meetings = (row.meetings as string[]).filter(Boolean)
  const actions = (row.actions as Array<{ action: string; deadline: string }>)
    .filter((a) => a.action)

  let out = `**${row.person}** appeared in ${meetings.length} meeting(s): ${meetings.join(", ") || "none"}.`
  if (actions.length) {
    out += `\n\nAction items assigned:\n`
    out += actions.map((a) => `- ${a.action}${a.deadline ? ` (due: ${a.deadline})` : ""}`).join("\n")
  }
  return out
}

async function runProjectQuery(neo4j: Neo4jGraph, entityId: string): Promise<string> {
  const result = await neo4j.query(
    `MATCH (p:Project {id: $projectId})
     OPTIONAL MATCH (p)-[:MENTIONED_IN]->(m:Meeting)
     OPTIONAL MATCH (m)-[:DECIDED_TO]->(dec:Decision)
     RETURN p.name AS project,
            collect(DISTINCT { title: m.title, time: m.startTime }) AS meetings,
            collect(DISTINCT dec.text) AS decisions
     ORDER BY m.startTime ASC`,
    { projectId: entityId }
  ) as Array<Record<string, unknown>>

  if (!result.length || !result[0].project) {
    return `No information found for project "${entityId}".`
  }

  const row = result[0]
  const meetings = (row.meetings as Array<{ title: string; time: string }>).filter((m) => m.title)
  const decisions = (row.decisions as string[]).filter(Boolean)

  let out = `**${row.project}** was discussed in ${meetings.length} meeting(s):\n`
  out += meetings.map((m) => `- ${m.title}${m.time ? ` (${m.time.substring(0, 10)})` : ""}`).join("\n")
  if (decisions.length) {
    out += `\n\nDecisions made:\n`
    out += decisions.map((d) => `- ${d}`).join("\n")
  }
  return out
}

async function runTopicQuery(neo4j: Neo4jGraph, entityId: string): Promise<string> {
  const result = await neo4j.query(
    `MATCH (t:Topic {id: $topicId})<-[:DISCUSSED]-(m:Meeting)
     RETURN t.name AS topic,
            collect({ title: m.title, time: m.startTime }) AS meetings
     ORDER BY m.startTime DESC`,
    { topicId: entityId }
  ) as Array<Record<string, unknown>>

  if (!result.length || !result[0].topic) {
    return `No information found for topic "${entityId}".`
  }

  const row = result[0]
  const meetings = (row.meetings as Array<{ title: string; time: string }>).filter((m) => m.title)

  let out = `**${row.topic}** was discussed in ${meetings.length} meeting(s):\n`
  out += meetings.map((m) => `- ${m.title}${m.time ? ` (${m.time.substring(0, 10)})` : ""}`).join("\n")
  return out
}

async function runActionItemQuery(neo4j: Neo4jGraph): Promise<string> {
  const result = await neo4j.query(
    `MATCH (a:ActionItem)
     OPTIONAL MATCH (a)-[:ASSIGNED_TO]->(s:Speaker)
     OPTIONAL MATCH (a)-[:HAS_DEADLINE]->(d:Deadline)
     OPTIONAL MATCH (a)-[:MENTIONED_IN]->(m:Meeting)
     RETURN a.text AS action,
            s.name AS assignee,
            d.date AS deadline,
            collect(DISTINCT m.title) AS meetings
     ORDER BY d.date ASC
     LIMIT 20`
  ) as Array<Record<string, unknown>>

  if (!result.length) return "No action items found."

  return result
    .map((row) => {
      let line = `- **${row.action}**`
      if (row.assignee) line += ` → ${row.assignee}`
      if (row.deadline) line += ` (due: ${row.deadline})`
      return line
    })
    .join("\n")
}

async function runMeetingQuery(neo4j: Neo4jGraph, question: string): Promise<string> {
  // Extract rough date range from question via Groq
  let dateFilter = ""
  try {
    const dateResp = await groq.chat.completions.create({
      model: FAST_MODEL,
      temperature: 0,
      max_tokens: 80,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract a date range from the question. Today is ${new Date().toISOString().split("T")[0]}.
Return ONLY: { "from": "YYYY-MM-DD or null", "to": "YYYY-MM-DD or null" }`,
        },
        { role: "user", content: question },
      ],
    })
    const parsed = JSON.parse(dateResp.choices[0]?.message?.content ?? "{}")
    if (parsed.from) dateFilter = `WHERE m.startTime >= datetime('${parsed.from}T00:00:00')`
    if (parsed.to) dateFilter += ` ${dateFilter ? "AND" : "WHERE"} m.startTime <= datetime('${parsed.to}T23:59:59')`
  } catch { /* ignore, run without date filter */ }

  const result = await neo4j.query(
    `MATCH (m:Meeting)
     ${dateFilter}
     OPTIONAL MATCH (s:Speaker)-[:SPOKE_IN]->(m)
     OPTIONAL MATCH (m)-[:DECIDED_TO]->(dec:Decision)
     RETURN m.title AS title,
            m.startTime AS startTime,
            collect(DISTINCT s.name) AS speakers,
            collect(DISTINCT dec.text) AS decisions
     ORDER BY m.startTime DESC
     LIMIT 10`
  ) as Array<Record<string, unknown>>

  if (!result.length) return "No meetings found for that time range."

  return result
    .map((row) => {
      const date = row.startTime ? String(row.startTime).substring(0, 10) : "unknown date"
      const speakers = (row.speakers as string[]).filter(Boolean).join(", ")
      const decisions = (row.decisions as string[]).filter(Boolean)
      let out = `**${row.title}** (${date})${speakers ? ` — ${speakers}` : ""}`
      if (decisions.length) out += `\n  Decisions: ${decisions.join("; ")}`
      return out
    })
    .join("\n\n")
}

async function runGeneralQuery(neo4j: Neo4jGraph, question: string): Promise<string> {
  // Fallback: use Groq to answer from graph stats + recent activity
  const stats = await neo4j.query(
    `MATCH (m:Meeting)
     OPTIONAL MATCH (a:ActionItem)-[:MENTIONED_IN]->(m)
     OPTIONAL MATCH (s:Speaker)-[:SPOKE_IN]->(m)
     RETURN m.title AS title, m.startTime AS time,
            count(DISTINCT a) AS actionCount,
            count(DISTINCT s) AS speakerCount
     ORDER BY m.startTime DESC LIMIT 5`
  ) as Array<Record<string, unknown>>

  const context = stats
    .map((r) => `Meeting: ${r.title}, speakers: ${r.speakerCount}, actions: ${r.actionCount}`)
    .join("\n")

  try {
    const response = await groq.chat.completions.create({
      model: SMART_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: "You answer questions about meeting history based on provided graph data. Be concise.",
        },
        {
          role: "user",
          content: `Graph data:\n${context}\n\nQuestion: ${question}`,
        },
      ],
    })
    return response.choices[0]?.message?.content ?? "Unable to generate response."
  } catch {
    return context || "No meeting data available."
  }
}

// ---------------------------------------------------------------------------
// 3a. queryGraphMemory — intent router (replaces GraphCypherQAChain)
// ---------------------------------------------------------------------------

export async function queryGraphMemory(question: string): Promise<string> {
  try {
    if (!question?.trim()) return "Error: Please provide a valid question."

    console.log(`🔍 Graph Query: "${question}"`)
    const neo4j = await getGraph()

    const { intent, entityName, normalizedId } = await detectIntent(question)
    console.log(`🎯 Intent: ${intent}, Entity: ${entityName} (${normalizedId})`)

    switch (intent) {
      case "PERSON":
        if (!normalizedId) return "Could not identify a person name in your question."
        return await runPersonQuery(neo4j, normalizedId)

      case "PROJECT":
        if (!normalizedId) return "Could not identify a project name in your question."
        return await runProjectQuery(neo4j, normalizedId)

      case "TOPIC":
        if (!normalizedId) return "Could not identify a topic in your question."
        return await runTopicQuery(neo4j, normalizedId)

      case "ACTION_ITEM":
        return await runActionItemQuery(neo4j)

      case "MEETING":
        return await runMeetingQuery(neo4j, question)

      case "GENERAL":
      default:
        return await runGeneralQuery(neo4j, question)
    }
  } catch (error) {
    console.error("❌ Graph Query Failed:", error instanceof Error ? error.message : error)
    return ""
  }
}

// ---------------------------------------------------------------------------
// Unchanged utility exports
// ---------------------------------------------------------------------------

export async function clearGraph(): Promise<boolean> {
  try {
    const neo4jGraph = await getGraph()
    await neo4jGraph.query("MATCH (n) DETACH DELETE n")
    console.log("🧹 Graph cleared successfully")
    return true
  } catch (error) {
    console.error("❌ Failed to clear graph:", error)
    return false
  }
}

export async function deleteGraphForMeeting(meetingId: string): Promise<boolean> {
  try {
    const neo4jGraph = await getGraph()
    // Only delete meeting-scoped nodes; shared nodes (Speaker, Project, Topic) are preserved
    await neo4jGraph.query(
      `MATCH (n)
       WHERE n.meetingId = $meetingId
         AND NOT n:Speaker AND NOT n:Project AND NOT n:Topic
       DETACH DELETE n`,
      { meetingId }
    )
    // Remove this meeting's relationships from shared nodes
    await neo4jGraph.query(
      `MATCH ()-[r {meetingId: $meetingId}]->()
       DELETE r`,
      { meetingId }
    )
    console.log(`🧹 Deleted meeting-scoped data for ${meetingId}`)
    return true
  } catch (error) {
    console.error(`Failed to delete graph for meeting ${meetingId}:`, error)
    return false
  }
}

export async function getGraphStatistics(): Promise<Record<string, unknown>> {
  try {
    const neo4j = await getGraph()
    const nodeStats = await neo4j.query(
      `MATCH (n) RETURN labels(n)[0] as type, count(*) as count ORDER BY count DESC`
    )
    const relStats = await neo4j.query(
      `MATCH ()-[r]->() RETURN type(r) as type, count(*) as count ORDER BY count DESC`
    )
    const nodeResult = nodeStats as Array<Record<string, unknown>>
    const relResult = relStats as Array<Record<string, unknown>>
    return {
      nodesByType: Object.fromEntries(nodeResult.map((s) => [s.type, s.count])),
      relationshipsByType: Object.fromEntries(relResult.map((s) => [s.type, s.count])),
      totalNodes: nodeResult.reduce((sum, s) => sum + Number(s.count ?? 0), 0),
      totalRelationships: relResult.reduce((sum, s) => sum + Number(s.count ?? 0), 0),
    }
  } catch (error) {
    console.error("Failed to get graph statistics:", error)
    return {}
  }
}