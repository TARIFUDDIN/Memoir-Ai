# RETRIEVAL AUDIT

## 1. Retrieval Flow
Currently, `lib/rag.ts` implements a parallel retrieval mechanism:
- **Vector Search:** Embeds the user query and searches Pinecone.
- **Graph Search:** Concurrently calls `queryGraphMemory(question)` from `lib/graph.ts`.
- **Assembly:** The raw string outputs from both sources are concatenated and injected into the LLM system prompt.

## 2. Chunking & Ranking Strategy
- **Chunking:** Implements parent-child chunking natively. The transcript is chunked, embeddings are created for small child chunks (~100 words), but the metadata stores a larger `parentContent`.
- **Ranking:** Currently relies purely on Pinecone's native Cosine Similarity. 
- **Missing Opportunities:** `lib/reranker.ts` exists in the codebase but is **not invoked** in the `rag.ts` pipeline. This means lower-quality vector matches are polluting the context window.

## 3. Vulnerabilities & Risks
- **Token Explosion:** Because the system dumps *both* Graph Cypher results and Pinecone results into the prompt without a compression layer, complex queries will easily overflow the LLM context window.
- **Graph/Vector Conflicts:** If Pinecone returns "Project X is delayed" but the Graph returns "Project X is completed", the LLM is left to guess which is accurate without timestamp weighting.
- **Hallucination Risks:** The Graph router uses an LLM to extract the entity ID (`detectIntent`). If a user asks about "The Alpha Redesign", and the LLM extracts `alpha`, but the database stores it as `redesign_alpha`, the graph will return nothing, heavily skewing the LLM's final answer.
