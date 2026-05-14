# GRAPH AUDIT

## 1. Schema & Entities
- **Nodes:** `Meeting`, `Speaker`, `ActionItem`, `Decision`, `Project`, `Topic`, `Deadline`.
- **Edges:** `SPOKE_IN`, `MENTIONED_IN`, `ASSIGNED_TO`, `HAS_DEADLINE`, `DECIDED_TO`, `DISCUSSED`, `CONTINUED_FROM`.

## 2. Scalability Bottlenecks
- **Node/Relationship Explosion:** Projects and Topics are linked via `MENTIONED_IN` or `DISCUSSED` to every single meeting they appear in. A long-running project will accumulate hundreds of edges. Querying `(p:Project)-[:MENTIONED_IN]->(m:Meeting)` will become extremely slow and return too much data.
- **Temporal Modeling Gaps:** The graph is largely static. If a `Project`'s status changes from "On Track" to "At Risk", the graph does not track the *evolution* of this state. It only tracks that the project was discussed.
- **Duplicate Entities:** The codebase includes a `resolveCoReferences` function using an LLM to merge duplicate names (e.g., "Mike" and "Michael"), which is excellent. However, this does not apply to Topics or Projects (e.g., "UI Redesign" vs "Frontend Redesign" will create two disparate graph nodes).

## 3. Query Complexity
- Cypher queries in `lib/graph.ts` are hardcoded and heavily reliant on `OPTIONAL MATCH`. In Neo4j, excessive `OPTIONAL MATCH` clauses without upper bounds on large datasets cause full-table scans, severely degrading performance.
