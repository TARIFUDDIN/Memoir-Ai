/**
 * lib/graph.ts — Phase 2: Temporal Memory Engine
 *
 * Architecture change: Static edges replaced with Snapshot nodes.
 * Pattern: (Entity) -[:HAS_STATE]-> (Snapshot) -[:RECORDED_IN]-> (Meeting)
 *
 * Each time a Project, ActionItem, or Topic appears in a meeting, a new
 * Snapshot is created capturing state at that point in time. This gives the
 * AI the ability to reason about *how* things evolved across meetings.
 *
 * Unchanged from Phase 3:
 * - MEETING intent temporal query (date-based, never node-ID lookup)
 * - resolveCoReferences
 * - Intent router / detectIntent
 */

import { Neo4jGraph } from "@langchain/community/graphs/neo4j_graph"
import Groq from "groq-sdk"
import
{
  enrichTranscript,
  normalizeName,
  type ExtractedEntity,
} from "./entity-extractor"

// ---------------------------------------------------------------------------
// Groq client
// ---------------------------------------------------------------------------
const groq = new Groq( { apiKey: process.env.GROQ_API_KEY! } )
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

async function getGraph (): Promise<Neo4jGraph>
{
  if ( graphInstance ) return graphInstance
  const maxRetries = 3
  for ( let attempt = 1; attempt <= maxRetries; attempt++ )
  {
    try
    {
      console.log( `🔗 Connecting to Neo4j (attempt ${ attempt }/${ maxRetries })...` )
      graphInstance = await Neo4jGraph.initialize( {
        url: process.env.NEO4J_URI!,
        username: process.env.NEO4J_USERNAME!,
        password: process.env.NEO4J_PASSWORD!,
        database: process.env.NEO4J_DATABASE!,
      } )
      console.log( "✅ Neo4j connection established" )
      return graphInstance
    } catch ( error )
    {
      console.error( `❌ Neo4j attempt ${ attempt } failed:`, error instanceof Error ? error.message : error )
      if ( attempt < maxRetries )
      {
        await new Promise( ( r ) => setTimeout( r, 2000 * Math.pow( 2, attempt - 1 ) ) )
      }
    }
  }
  throw new Error( "Failed to connect to Neo4j after retries" )
}

// ---------------------------------------------------------------------------
// Co-reference resolution (unchanged)
// ---------------------------------------------------------------------------

async function resolveCoReferences (
  entities: ExtractedEntity[]
): Promise<ExtractedEntity[]>
{
  const people = entities.filter( ( e ) => e.type === "PERSON" )
  if ( people.length < 2 ) return entities

  try
  {
    const nameList = people.map( ( p ) => p.value ).join( ", " )
    const response = await groq.chat.completions.create( {
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
          content: `Names from transcript: ${ nameList }`,
        },
      ],
    } )

    const content = response.choices[ 0 ]?.message?.content
    if ( !content ) return entities

    const parsed = JSON.parse( content.replace( /^```json\s*/i, "" ).replace( /```\s*$/i, "" ).trim() )
    const groups: Array<{ canonical: string; aliases: string[] }> = parsed.groups ?? []

    if ( groups.length === 0 ) return entities

    const aliasToCanonical = new Map<string, string>()
    for ( const group of groups )
    {
      const canonicalNorm = normalizeName( group.canonical )
      for ( const alias of group.aliases )
      {
        aliasToCanonical.set( normalizeName( alias ), canonicalNorm )
        aliasToCanonical.set( alias.toLowerCase().trim(), canonicalNorm )
      }
    }

    const seen = new Set<string>()
    const resolved: ExtractedEntity[] = []

    for ( const entity of entities )
    {
      if ( entity.type !== "PERSON" )
      {
        resolved.push( entity )
        continue
      }
      const mapped = aliasToCanonical.get( entity.normalizedValue ) ?? entity.normalizedValue
      if ( seen.has( mapped ) ) continue
      seen.add( mapped )
      resolved.push( { ...entity, normalizedValue: mapped } )
    }

    return resolved.map( ( entity ) =>
    {
      if ( entity.type !== "ACTION_ITEM" ) return entity
      const meta = entity.metadata as Record<string, unknown>
      if ( !meta.assignedTo ) return entity
      const remapped = aliasToCanonical.get( String( meta.assignedTo ) ) ?? String( meta.assignedTo )
      return { ...entity, metadata: { ...meta, assignedTo: remapped } }
    } )
  } catch ( err )
  {
    console.warn( "⚠️ Co-reference resolution failed:", err instanceof Error ? err.message : err )
    return entities
  }
}

// ---------------------------------------------------------------------------
// Helper: build a unique Snapshot ID
// ---------------------------------------------------------------------------

function snapshotId ( entityId: string, meetingId: string ): string
{
  return `snap_${ entityId }_${ meetingId }`
}

// ---------------------------------------------------------------------------
// addToKnowledgeGraph — Phase 2: Snapshot architecture
// ---------------------------------------------------------------------------

export async function addToKnowledgeGraph (
  transcript: unknown,
  meetingId: string,
  meetingTitle: string,
  meetingStartTime?: Date
): Promise<KnowledgeGraphData | null>
{
  try
  {
    if ( !transcript )
    {
      console.warn( "⚠️ Graph extraction skipped: No transcript provided" )
      return null
    }

    console.log( "🕸️ Starting Knowledge Graph Extraction (Phase 2 — Temporal)..." )

    // ------------------------------------------------------------------
    // 1. Normalise transcript to plain text
    // ------------------------------------------------------------------
    let textContent = ""
    if ( Array.isArray( transcript ) )
    {
      textContent = transcript
        .map( ( t: unknown ) =>
        {
          const item = t as Record<string, unknown>
          const text =
            Array.isArray( item.words ) && item.words.length > 0
              ? ( item.words as unknown[] ).map( ( w ) => String( ( w as Record<string, unknown> ).word ?? "" ) ).join( " " )
              : String( item.text ?? "[speaking]" )
          return `${ String( item.speaker ?? "Speaker" ) }: ${ text }`
        } )
        .join( "\n" )
    } else if ( typeof transcript === "string" )
    {
      textContent = transcript
    } else if ( transcript && typeof transcript === "object" && "text" in transcript )
    {
      textContent = String( ( transcript as Record<string, unknown> ).text )
    }

    if ( !textContent.trim() ) throw new Error( "EMPTY_TRANSCRIPT_CONTENT" )

    // ------------------------------------------------------------------
    // 2. Extract & de-duplicate entities
    // ------------------------------------------------------------------
    const enrichmentResult = await enrichTranscript( textContent )
    let entities = enrichmentResult.entities
    console.log( `✅ Extracted ${ entities.length } raw entities` )

    entities = await resolveCoReferences( entities )
    console.log( `✅ After co-reference resolution: ${ entities.length } entities` )

    // ------------------------------------------------------------------
    // 3. Build node / relationship lists (for the return value / logging)
    // ------------------------------------------------------------------
    const nodes: GraphNode[] = []
    const relationships: GraphRelationship[] = []

    const meetingTimestamp = meetingStartTime?.toISOString() ?? new Date().toISOString()

    // Meeting node — always a MERGE so re-processing is idempotent
    nodes.push( {
      type: "Meeting",
      id: meetingId,
      properties: {
        id: meetingId,
        title: meetingTitle,
        meetingId,
        startTime: meetingTimestamp,
      },
    } )

    const neo4j = await getGraph()

    // ------------------------------------------------------------------
    // 4. Upsert Meeting node
    // ------------------------------------------------------------------
    await neo4j.query(
      `MERGE (m:Meeting {id: $id})
       SET m += $properties`,
      { id: meetingId, properties: { id: meetingId, title: meetingTitle, meetingId, startTime: meetingTimestamp } }
    )

    // ------------------------------------------------------------------
    // 5. Process each entity
    // ------------------------------------------------------------------
    for ( const entity of entities )
    {
      // ----------------------------------------------------------------
      // PERSON — static node + SPOKE_IN (no Snapshot needed; presence
      //           in a meeting is a fact, not an evolving state)
      // ----------------------------------------------------------------
      if ( entity.type === "PERSON" )
      {
        nodes.push( {
          type: "Speaker",
          id: entity.normalizedValue,
          properties: { id: entity.normalizedValue, name: entity.value },
        } )
        relationships.push( {
          source: entity.normalizedValue,
          target: meetingId,
          type: "SPOKE_IN",
          properties: { meetingId },
        } )

        await neo4j.query(
          `MERGE (s:Speaker {id: $id})
           SET s += $properties
           WITH s
           MATCH (m:Meeting {id: $meetingId})
           MERGE (s)-[:SPOKE_IN {meetingId: $meetingId}]->(m)`,
          {
            id: entity.normalizedValue,
            properties: { id: entity.normalizedValue, name: entity.value },
            meetingId,
          }
        )
      }

      // ----------------------------------------------------------------
      // PROJECT — canonical node + Snapshot per meeting
      // ----------------------------------------------------------------
      if ( entity.type === "PROJECT" )
      {
        const projectId = entity.normalizedValue
        const snapId = snapshotId( projectId, meetingId )

        nodes.push( {
          type: "Project",
          id: projectId,
          properties: { id: projectId, name: entity.value },
        } )
        nodes.push( {
          type: "Snapshot",
          id: snapId,
          properties: {
            id: snapId,
            timestamp: meetingTimestamp,
            meetingId,
            entityType: "PROJECT",
            confidence: entity.confidence,
            status: ( entity.metadata as Record<string, unknown> ).status ?? null,
            sentiment: ( entity.metadata as Record<string, unknown> ).sentiment ?? null,
            risk: ( entity.metadata as Record<string, unknown> ).risk ?? null,
          },
        } )
        relationships.push( { source: projectId, target: snapId, type: "HAS_STATE" } )
        relationships.push( { source: snapId, target: meetingId, type: "RECORDED_IN", properties: { meetingId } } )

        await neo4j.query(
          `MERGE (p:Project {id: $projectId})
           SET p.name = $name
           WITH p
           MATCH (m:Meeting {id: $meetingId})
           CREATE (snap:Snapshot {
             id: $snapId,
             timestamp: datetime($timestamp),
             meetingId: $meetingId,
             entityType: 'PROJECT',
             confidence: $confidence,
             status: $status,
             sentiment: $sentiment,
             risk: $risk
           })
           MERGE (p)-[:HAS_STATE]->(snap)
           MERGE (snap)-[:RECORDED_IN]->(m)`,
          {
            projectId,
            name: entity.value,
            meetingId,
            snapId,
            timestamp: meetingTimestamp,
            confidence: entity.confidence,
            status: ( entity.metadata as Record<string, unknown> ).status ?? null,
            sentiment: ( entity.metadata as Record<string, unknown> ).sentiment ?? null,
            risk: ( entity.metadata as Record<string, unknown> ).risk ?? null,
          }
        )
      }

      // ----------------------------------------------------------------
      // TOPIC — canonical node + Snapshot per meeting
      // ----------------------------------------------------------------
      if ( entity.type === "TOPIC" )
      {
        const topicId = entity.normalizedValue
        const snapId = snapshotId( topicId, meetingId )

        nodes.push( {
          type: "Topic",
          id: topicId,
          properties: { id: topicId, name: entity.value },
        } )
        nodes.push( {
          type: "Snapshot",
          id: snapId,
          properties: {
            id: snapId,
            timestamp: meetingTimestamp,
            meetingId,
            entityType: "TOPIC",
            confidence: entity.confidence,
            sentiment: ( entity.metadata as Record<string, unknown> ).sentiment ?? null,
          },
        } )
        relationships.push( { source: topicId, target: snapId, type: "HAS_STATE" } )
        relationships.push( { source: snapId, target: meetingId, type: "RECORDED_IN", properties: { meetingId } } )

        await neo4j.query(
          `MERGE (t:Topic {id: $topicId})
           SET t.name = $name
           WITH t
           MATCH (m:Meeting {id: $meetingId})
           CREATE (snap:Snapshot {
             id: $snapId,
             timestamp: datetime($timestamp),
             meetingId: $meetingId,
             entityType: 'TOPIC',
             confidence: $confidence,
             sentiment: $sentiment
           })
           MERGE (t)-[:HAS_STATE]->(snap)
           MERGE (snap)-[:RECORDED_IN]->(m)`,
          {
            topicId,
            name: entity.value,
            meetingId,
            snapId,
            timestamp: meetingTimestamp,
            confidence: entity.confidence,
            sentiment: ( entity.metadata as Record<string, unknown> ).sentiment ?? null,
          }
        )
      }

      // ----------------------------------------------------------------
      // ACTION_ITEM — canonical node + Snapshot (captures deadline /
      //               assignedTo at this point in time)
      // ----------------------------------------------------------------
      if ( entity.type === "ACTION_ITEM" )
      {
        const actionId = `${ meetingId }_${ entity.normalizedValue }`
        const snapId = snapshotId( actionId, meetingId )
        const meta = entity.metadata as Record<string, unknown>
        const assignedTo = meta.assignedTo ? String( meta.assignedTo ) : null
        const deadline = meta.deadline ? String( meta.deadline ) : null

        nodes.push( {
          type: "ActionItem",
          id: actionId,
          properties: { id: actionId, text: entity.value, meetingId },
        } )
        nodes.push( {
          type: "Snapshot",
          id: snapId,
          properties: {
            id: snapId,
            timestamp: meetingTimestamp,
            meetingId,
            entityType: "ACTION_ITEM",
            confidence: entity.confidence,
            assignedTo,
            deadline,
            status: ( meta.status as string ) ?? "open",
          },
        } )
        relationships.push( { source: actionId, target: snapId, type: "HAS_STATE" } )
        relationships.push( { source: snapId, target: meetingId, type: "RECORDED_IN", properties: { meetingId } } )

        await neo4j.query(
          `MERGE (a:ActionItem {id: $actionId})
           SET a.text = $text, a.meetingId = $meetingId
           WITH a
           MATCH (m:Meeting {id: $meetingId})
           CREATE (snap:Snapshot {
             id: $snapId,
             timestamp: datetime($timestamp),
             meetingId: $meetingId,
             entityType: 'ACTION_ITEM',
             confidence: $confidence,
             assignedTo: $assignedTo,
             deadline: $deadline,
             status: $status
           })
           MERGE (a)-[:HAS_STATE]->(snap)
           MERGE (snap)-[:RECORDED_IN]->(m)
           WITH a, snap
           // Also link ActionItem to its assignee Speaker node if it exists
           CALL {
             WITH a, snap
             MATCH (s:Speaker {id: $assignedTo})
             MERGE (a)-[:ASSIGNED_TO {meetingId: $meetingId}]->(s)
             RETURN count(*) AS _
           }
           RETURN a`,
          {
            actionId,
            text: entity.value,
            meetingId,
            snapId,
            timestamp: meetingTimestamp,
            confidence: entity.confidence,
            assignedTo,
            deadline,
            status: ( meta.status as string ) ?? "open",
          }
        )
      }

      // ----------------------------------------------------------------
      // DECISION — unchanged (decisions are facts, not evolving state)
      // ----------------------------------------------------------------
      if ( entity.type === "DECISION" )
      {
        const decisionId = `${ meetingId }_${ entity.normalizedValue }`
        nodes.push( {
          type: "Decision",
          id: decisionId,
          properties: { id: decisionId, text: entity.value, meetingId },
        } )
        relationships.push( {
          source: meetingId,
          target: decisionId,
          type: "DECIDED_TO",
          properties: { meetingId },
        } )

        await neo4j.query(
          `MERGE (dec:Decision {id: $id})
           SET dec.text = $text, dec.meetingId = $meetingId
           WITH dec
           MATCH (m:Meeting {id: $meetingId})
           MERGE (m)-[:DECIDED_TO {meetingId: $meetingId}]->(dec)`,
          { id: decisionId, text: entity.value, meetingId }
        )
      }
    }

    // ------------------------------------------------------------------
    // 6. Link consecutive meetings via shared entities (cross-meeting continuity)
    // ------------------------------------------------------------------
    await neo4j.query(
      `MATCH (curr:Meeting {id: $meetingId})
       MATCH (prev:Meeting)
       WHERE prev.id <> $meetingId
         AND prev.startTime < curr.startTime
       MATCH (curr)<-[:RECORDED_IN]-(snap1:Snapshot)<-[:HAS_STATE]-(shared)
       MATCH (shared)-[:HAS_STATE]->(snap2:Snapshot)-[:RECORDED_IN]->(prev)
       WITH curr, prev ORDER BY prev.startTime DESC LIMIT 1
       MERGE (curr)-[:CONTINUED_FROM]->(prev)`,
      { meetingId }
    )

    console.log( `🕸️ Phase 2 Graph Complete: ${ nodes.length } nodes, ${ relationships.length } relationships` )
    return { nodes, relationships, meetingId, extractedAt: new Date() }

  } catch ( error )
  {
    console.error( "❌ Knowledge Graph Extraction Failed:", error instanceof Error ? error.message : error )
    return null
  }
}

// ---------------------------------------------------------------------------
// Intent detection (unchanged)
// ---------------------------------------------------------------------------

async function detectIntent ( question: string ): Promise<IntentResult>
{
  try
  {
    const response = await groq.chat.completions.create( {
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
- PERSON: asks about a specific named person ("what did Alice work on", "Bob's tasks")
- PROJECT: asks about a named project ("Project Phoenix status", "the redesign")
- TOPIC: asks about a topic/theme ("what was discussed about security")
- ACTION_ITEM: asks about tasks/todos ("overdue tasks", "what actions are pending")
- MEETING: asks about meetings by time/recency ("last meeting", "yesterday's call", "recent meetings") — entityName should be null for these
- GENERAL: anything else`,
        },
        { role: "user", content: question },
      ],
    } )

    const content = response.choices[ 0 ]?.message?.content
    if ( !content ) return { intent: "GENERAL", entityName: null, normalizedId: null }

    const parsed = JSON.parse( content.replace( /^```json\s*/i, "" ).replace( /```\s*$/i, "" ).trim() )

    const intent = ( parsed.intent as QueryIntent ) ?? "GENERAL"
    const entityName = intent === "MEETING" ? null : ( parsed.entityName ?? null )

    return {
      intent,
      entityName,
      normalizedId: entityName ? normalizeName( String( entityName ) ) : null,
    }
  } catch
  {
    return { intent: "GENERAL", entityName: null, normalizedId: null }
  }
}

// ---------------------------------------------------------------------------
// Cypher query runners — Phase 2: traverse HAS_STATE → Snapshot
// ---------------------------------------------------------------------------

async function runPersonQuery ( neo4j: Neo4jGraph, entityId: string ): Promise<string>
{
  // PERSON nodes are still linked directly (SPOKE_IN); no Snapshot needed here.
  const result = await neo4j.query(
    `MATCH (s:Speaker {id: $personId})
     OPTIONAL MATCH (s)-[:SPOKE_IN]->(m:Meeting)
     // Action items assigned to this person via the Snapshot
     OPTIONAL MATCH (a:ActionItem)-[:ASSIGNED_TO]->(s)
     OPTIONAL MATCH (a)-[:HAS_STATE]->(snap:Snapshot)
     RETURN
       s.name AS person,
       collect(DISTINCT m.title) AS meetings,
       collect(DISTINCT {
         action: a.text,
         deadline: snap.deadline,
         status: snap.status,
         assignedAt: toString(snap.timestamp)
       }) AS actions`,
    { personId: entityId }
  ) as Array<Record<string, unknown>>

  if ( !result.length || !result[ 0 ].person )
  {
    // Fuzzy fallback
    const fuzzy = await neo4j.query(
      `MATCH (s:Speaker)
       WHERE toLower(s.id) CONTAINS toLower($partial)
          OR toLower(s.name) CONTAINS toLower($partial)
       OPTIONAL MATCH (s)-[:SPOKE_IN]->(m:Meeting)
       OPTIONAL MATCH (a:ActionItem)-[:ASSIGNED_TO]->(s)
       OPTIONAL MATCH (a)-[:HAS_STATE]->(snap:Snapshot)
       RETURN s.name AS person,
              collect(DISTINCT m.title) AS meetings,
              collect(DISTINCT { action: a.text, deadline: snap.deadline, status: snap.status }) AS actions
       LIMIT 3`,
      { partial: entityId }
    ) as Array<Record<string, unknown>>

    if ( !fuzzy.length || !fuzzy[ 0 ].person )
    {
      return `No information found for person "${ entityId }".`
    }

    return fuzzy.map( row =>
    {
      const meetings = ( row.meetings as string[] ).filter( Boolean )
      const actions = ( row.actions as Array<{ action: string; deadline: string; status: string }> ).filter( a => a.action )
      let out = `**${ row.person }** appeared in ${ meetings.length } meeting(s): ${ meetings.join( ", " ) || "none" }.`
      if ( actions.length )
      {
        out += `\n\nAction items:\n`
        out += actions.map( a =>
          `- ${ a.action }${ a.deadline ? ` (due: ${ a.deadline })` : "" }${ a.status ? ` [status: ${ a.status }]` : "" }`
        ).join( "\n" )
      }
      return out
    } ).join( "\n\n" )
  }

  const row = result[ 0 ]
  const meetings = ( row.meetings as string[] ).filter( Boolean )
  const actions = ( row.actions as Array<{ action: string; deadline: string; status: string; assignedAt: string }> ).filter( a => a.action )

  let out = `**${ row.person }** appeared in ${ meetings.length } meeting(s): ${ meetings.join( ", " ) || "none" }.`
  if ( actions.length )
  {
    out += `\n\nAction items:\n`
    out += actions.map( a =>
      `- ${ a.action }${ a.deadline ? ` (due: ${ a.deadline })` : "" }${ a.status ? ` [status: ${ a.status }]` : "" }`
    ).join( "\n" )
  }
  return out
}

async function runProjectQuery ( neo4j: Neo4jGraph, entityId: string ): Promise<string>
{
  // Traverse HAS_STATE → Snapshot → RECORDED_IN → Meeting; order by timestamp DESC
  const result = await neo4j.query(
    `MATCH (p:Project)
     WHERE p.id = $projectId OR toLower(p.name) CONTAINS toLower($projectId)
     OPTIONAL MATCH (p)-[:HAS_STATE]->(snap:Snapshot)-[:RECORDED_IN]->(m:Meeting)
     OPTIONAL MATCH (m)-[:DECIDED_TO]->(dec:Decision)
     WITH p,
          snap,
          m,
          collect(DISTINCT dec.text) AS decisions
     ORDER BY snap.timestamp DESC
     LIMIT 5
     RETURN p.name AS project,
            collect({
              date: toString(snap.timestamp),
              meetingTitle: m.title,
              status: snap.status,
              risk: snap.risk,
              sentiment: snap.sentiment,
              confidence: snap.confidence,
              decisions: decisions
            }) AS timeline`,
    { projectId: entityId }
  ) as Array<Record<string, unknown>>

  if ( !result.length || !result[ 0 ].project )
  {
    return `No information found for project "${ entityId }".`
  }

  const row = result[ 0 ]
  const timeline = ( row.timeline as Array<{
    date: string
    meetingTitle: string
    status: string | null
    risk: string | null
    sentiment: string | null
    confidence: number
    decisions: string[]
  }> ).filter( t => t.meetingTitle )

  let out = `**${ row.project }** — Evolution Timeline (${ timeline.length } snapshot(s)):\n`
  out += timeline.map( t =>
  {
    const date = t.date ? t.date.substring( 0, 10 ) : "unknown date"
    let line = `- [${ date }] *${ t.meetingTitle }*`
    const meta: string[] = []
    if ( t.status ) meta.push( `status: ${ t.status }` )
    if ( t.risk ) meta.push( `risk: ${ t.risk }` )
    if ( t.sentiment ) meta.push( `sentiment: ${ t.sentiment }` )
    if ( meta.length ) line += ` — ${ meta.join( ", " ) }`
    if ( t.decisions?.length ) line += `\n  Decisions: ${ t.decisions.join( "; " ) }`
    return line
  } ).join( "\n" )

  return out
}

async function runTopicQuery ( neo4j: Neo4jGraph, entityId: string ): Promise<string>
{
  const result = await neo4j.query(
    `MATCH (t:Topic)
     WHERE t.id = $topicId OR toLower(t.name) CONTAINS toLower($topicId)
     OPTIONAL MATCH (t)-[:HAS_STATE]->(snap:Snapshot)-[:RECORDED_IN]->(m:Meeting)
     WITH t, snap, m
     ORDER BY snap.timestamp DESC
     LIMIT 5
     RETURN t.name AS topic,
            collect({
              date: toString(snap.timestamp),
              meetingTitle: m.title,
              sentiment: snap.sentiment,
              confidence: snap.confidence
            }) AS timeline`,
    { topicId: entityId }
  ) as Array<Record<string, unknown>>

  if ( !result.length || !result[ 0 ].topic )
  {
    return `No information found for topic "${ entityId }".`
  }

  const row = result[ 0 ]
  const timeline = ( row.timeline as Array<{
    date: string
    meetingTitle: string
    sentiment: string | null
    confidence: number
  }> ).filter( t => t.meetingTitle )

  let out = `**${ row.topic }** — Discussion Timeline (${ timeline.length } occurrence(s)):\n`
  out += timeline.map( t =>
  {
    const date = t.date ? t.date.substring( 0, 10 ) : "unknown date"
    let line = `- [${ date }] *${ t.meetingTitle }*`
    if ( t.sentiment ) line += ` — sentiment: ${ t.sentiment }`
    return line
  } ).join( "\n" )

  return out
}

async function runActionItemQuery ( neo4j: Neo4jGraph ): Promise<string>
{
  // Pull the most recent Snapshot per ActionItem to get current state
  const result = await neo4j.query(
    `MATCH (a:ActionItem)-[:HAS_STATE]->(snap:Snapshot)-[:RECORDED_IN]->(m:Meeting)
     WITH a, snap, m
     ORDER BY snap.timestamp DESC
     // Keep only the latest snapshot per ActionItem
     WITH a, head(collect(snap)) AS latestSnap, head(collect(m)) AS latestMeeting
     OPTIONAL MATCH (a)-[:ASSIGNED_TO]->(s:Speaker)
     RETURN a.text AS action,
            s.name AS assignee,
            latestSnap.deadline AS deadline,
            latestSnap.status AS status,
            toString(latestSnap.timestamp) AS lastSeen,
            latestMeeting.title AS lastMeeting
     ORDER BY latestSnap.deadline ASC
     LIMIT 20`
  ) as Array<Record<string, unknown>>

  if ( !result.length ) return "No action items found."

  return result
    .map( ( row ) =>
    {
      let line = `- **${ row.action }**`
      if ( row.assignee ) line += ` → ${ row.assignee }`
      if ( row.deadline ) line += ` (due: ${ row.deadline })`
      if ( row.status ) line += ` [status: ${ row.status }]`
      if ( row.lastMeeting ) line += `\n  Last seen in: *${ row.lastMeeting }*${ row.lastSeen ? ` (${ String( row.lastSeen ).substring( 0, 10 ) })` : "" }`
      return line
    } )
    .join( "\n" )
}

async function runMeetingQuery ( neo4j: Neo4jGraph, question: string ): Promise<string>
{
  let dateFilter = ""
  try
  {
    const dateResp = await groq.chat.completions.create( {
      model: FAST_MODEL,
      temperature: 0,
      max_tokens: 80,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract a date range from the question. Today is ${ new Date().toISOString().split( "T" )[ 0 ] }.
Return ONLY: { "from": "YYYY-MM-DD or null", "to": "YYYY-MM-DD or null", "wantMostRecent": true | false }
wantMostRecent = true when the question says "last", "latest", "most recent", "recent".`,
        },
        { role: "user", content: question },
      ],
    } )
    const parsed = JSON.parse( dateResp.choices[ 0 ]?.message?.content ?? "{}" )
    if ( parsed.from ) dateFilter = `WHERE m.startTime >= datetime('${ parsed.from }T00:00:00')`
    if ( parsed.to ) dateFilter += ` ${ dateFilter ? "AND" : "WHERE" } m.startTime <= datetime('${ parsed.to }T23:59:59')`
  } catch { /* run without date filter */ }

  const result = await neo4j.query(
    `MATCH (m:Meeting)
     ${ dateFilter }
     OPTIONAL MATCH (s:Speaker)-[:SPOKE_IN]->(m)
     OPTIONAL MATCH (m)-[:DECIDED_TO]->(dec:Decision)
     // Count action item snapshots recorded in this meeting
     OPTIONAL MATCH (snap:Snapshot {entityType: 'ACTION_ITEM'})-[:RECORDED_IN]->(m)
     RETURN m.title AS title,
            m.startTime AS startTime,
            collect(DISTINCT s.name) AS speakers,
            collect(DISTINCT dec.text) AS decisions,
            count(DISTINCT snap) AS actionCount
     ORDER BY m.startTime DESC
     LIMIT 5`
  ) as Array<Record<string, unknown>>

  if ( !result.length ) return "No meetings found."

  return result
    .map( ( row ) =>
    {
      const date = row.startTime ? String( row.startTime ).substring( 0, 10 ) : "unknown date"
      const speakers = ( row.speakers as string[] ).filter( Boolean )
      const decisions = ( row.decisions as string[] ).filter( Boolean )
      let out = `**${ row.title }** (${ date })`
      if ( speakers.length ) out += `\nParticipants: ${ speakers.join( ", " ) }`
      if ( decisions.length ) out += `\nDecisions: ${ decisions.join( "; " ) }`
      if ( row.actionCount ) out += `\nAction items tracked: ${ row.actionCount }`
      return out
    } )
    .join( "\n\n" )
}

async function runGeneralQuery ( neo4j: Neo4jGraph, question: string ): Promise<string>
{
  const stats = await neo4j.query(
    `MATCH (m:Meeting)
     OPTIONAL MATCH (s:Speaker)-[:SPOKE_IN]->(m)
     OPTIONAL MATCH (snap:Snapshot {entityType: 'ACTION_ITEM'})-[:RECORDED_IN]->(m)
     RETURN m.title AS title, m.startTime AS time,
            collect(DISTINCT s.name) AS speakers,
            count(DISTINCT snap) AS actionCount
     ORDER BY m.startTime DESC LIMIT 5`
  ) as Array<Record<string, unknown>>

  const context = stats
    .map( ( r ) =>
    {
      const speakers = ( r.speakers as string[] ).filter( Boolean ).join( ", " )
      return `Meeting: "${ r.title }" | participants: ${ speakers || "unknown" } | action snapshots: ${ r.actionCount }`
    } )
    .join( "\n" )

  if ( !context ) return "No meeting data available in the knowledge graph."

  try
  {
    const response = await groq.chat.completions.create( {
      model: SMART_MODEL,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: "Answer questions about meeting history based on the graph data below. Be concise and specific.",
        },
        {
          role: "user",
          content: `Graph data:\n${ context }\n\nQuestion: ${ question }`,
        },
      ],
    } )
    return response.choices[ 0 ]?.message?.content ?? context
  } catch
  {
    return context
  }
}

// ---------------------------------------------------------------------------
// queryGraphMemory — intent router (unchanged)
// ---------------------------------------------------------------------------

export async function queryGraphMemory ( question: string ): Promise<string>
{
  try
  {
    if ( !question?.trim() ) return "Error: Please provide a valid question."

    console.log( `🔍 Graph Query: "${ question }"` )
    const neo4j = await getGraph()

    const { intent, entityName, normalizedId } = await detectIntent( question )
    console.log( `🎯 Intent: ${ intent }, Entity: ${ entityName } (${ normalizedId })` )

    switch ( intent )
    {
      case "PERSON":
        if ( !normalizedId ) return "Could not identify a person name in your question."
        return await runPersonQuery( neo4j, normalizedId )

      case "PROJECT":
        if ( !normalizedId ) return "Could not identify a project name in your question."
        return await runProjectQuery( neo4j, normalizedId )

      case "TOPIC":
        if ( !normalizedId ) return "Could not identify a topic in your question."
        return await runTopicQuery( neo4j, normalizedId )

      case "ACTION_ITEM":
        return await runActionItemQuery( neo4j )

      case "MEETING":
        return await runMeetingQuery( neo4j, question )

      case "GENERAL":
      default:
        return await runGeneralQuery( neo4j, question )
    }
  } catch ( error )
  {
    console.error( "❌ Graph Query Failed:", error instanceof Error ? error.message : error )
    return ""
  }
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

export async function clearGraph (): Promise<boolean>
{
  try
  {
    const neo4jGraph = await getGraph()
    await neo4jGraph.query( "MATCH (n) DETACH DELETE n" )
    console.log( "🧹 Graph cleared successfully" )
    return true
  } catch ( error )
  {
    console.error( "❌ Failed to clear graph:", error )
    return false
  }
}

export async function deleteGraphForMeeting ( meetingId: string ): Promise<boolean>
{
  try
  {
    const neo4jGraph = await getGraph()

    // Delete Snapshot nodes recorded in this meeting (they are meeting-scoped by design)
    await neo4jGraph.query(
      `MATCH (snap:Snapshot)-[:RECORDED_IN]->(m:Meeting {id: $meetingId})
       DETACH DELETE snap`,
      { meetingId }
    )

    // Delete Decisions created in this meeting
    await neo4jGraph.query(
      `MATCH (dec:Decision {meetingId: $meetingId})
       DETACH DELETE dec`,
      { meetingId }
    )

    // Delete relationships scoped to this meeting (SPOKE_IN, ASSIGNED_TO, DECIDED_TO)
    await neo4jGraph.query(
      `MATCH ()-[r {meetingId: $meetingId}]->()
       DELETE r`,
      { meetingId }
    )

    // Delete orphaned ActionItem nodes (no remaining HAS_STATE edges)
    await neo4jGraph.query(
      `MATCH (a:ActionItem)
       WHERE NOT (a)-[:HAS_STATE]->()
       DETACH DELETE a`
    )

    console.log( `🧹 Deleted meeting-scoped data for ${ meetingId }` )
    return true
  } catch ( error )
  {
    console.error( `Failed to delete graph for meeting ${ meetingId }:`, error )
    return false
  }
}

export async function getGraphStatistics (): Promise<Record<string, unknown>>
{
  try
  {
    const neo4j = await getGraph()
    const nodeStats = await neo4j.query(
      `MATCH (n) RETURN labels(n)[0] as type, count(*) as count ORDER BY count DESC`
    )
    const relStats = await neo4j.query(
      `MATCH ()-[r]->() RETURN type(r) as type, count(*) as count ORDER BY count DESC`
    )
    const snapshotStats = await neo4j.query(
      `MATCH (snap:Snapshot)
       RETURN snap.entityType AS entityType, count(*) AS count
       ORDER BY count DESC`
    )
    const nodeResult = nodeStats as Array<Record<string, unknown>>
    const relResult = relStats as Array<Record<string, unknown>>
    const snapResult = snapshotStats as Array<Record<string, unknown>>
    return {
      nodesByType: Object.fromEntries( nodeResult.map( ( s ) => [ s.type, s.count ] ) ),
      relationshipsByType: Object.fromEntries( relResult.map( ( s ) => [ s.type, s.count ] ) ),
      snapshotsByEntityType: Object.fromEntries( snapResult.map( ( s ) => [ s.entityType, s.count ] ) ),
      totalNodes: nodeResult.reduce( ( sum, s ) => sum + Number( s.count ?? 0 ), 0 ),
      totalRelationships: relResult.reduce( ( sum, s ) => sum + Number( s.count ?? 0 ), 0 ),
    }
  } catch ( error )
  {
    console.error( "Failed to get graph statistics:", error )
    return {}
  }
}