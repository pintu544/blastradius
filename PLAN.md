# BlastRadius — Build Plan (Graph Hacks 2026)

> Event rule: submission + main FalkorDB implementation must be **new work
> completed during the event (Oct 15–18, 2026)**. This plan is prep only.

## 1. Architecture overview

```
┌──────────────┐      ┌──────────────────┐      ┌─────────────────┐
│    Client    │      │      Server      │      │    FalkorDB     │
│ React + Vite │◄────►│ Node 20 + Express│◄────►│ code graph      │
│ chat + graph │ REST │  /api/scan       │ Cypher│ one graph per   │
│ visualization│      │  /api/findings   │ tools │ repo (multigraph)
│              │      │  /api/ask        │      │                 │
└──────────────┘      └────────┬─────────┘      └─────────────────┘
                               │ LLM tool calls
                        ┌──────▼──────┐
                        │   Agent     │
                        │ scan→trace  │
                        │ →rank→act   │
                        └─────────────┘
```

- **Ingestion pipeline** (Day 1): clone repo → parse (tree-sitter for JS/TS
  first; extend later) → write nodes/edges to FalkorDB. One isolated graph
  per repo via FalkorDB multigraph (also per-user isolation for memory).
- **Detection layer** (Day 2): pattern rules over the graph (hardcoded
  secrets, `eval`/`exec`, SQL string concat, insecure randomness, …) seeded
  as `Finding` nodes linked to the offending code nodes.
- **Agent** (Day 2): LLM with tool calling. Tools: `cypher_query`,
  `blast_radius(finding_id, depth)`, `impact_rank()`, `owner_of(node)`,
  `mark_fixed(finding_id)`. Agent loop: scan → trace → rank → propose fix →
  remember.
- **Client** (Day 3): findings ranked by blast radius; click a finding →
  the traversed path lights up on a force-directed graph; chat box for
  "what breaks if I change X?" with the Cypher + path shown (explainability
  is an explicit judging signal).
- **Deploy** (Day 3): server → Render/Railway, client → Vercel, FalkorDB →
  hosted or Docker on the server host. Live deployment preferred by judges.

## 2. Proposed graph data model

Node labels:

| Label      | Key properties                                          |
|------------|---------------------------------------------------------|
| `File`     | path, language, loc                                     |
| `Function` | name, qualifiedName, file, startLine, endLine           |
| `Class`    | name, qualifiedName, file                               |
| `Import`   | module, importedNames, file                             |
| `Commit`   | sha, message, timestamp                                 |
| `Author`   | name, email                                             |
| `Finding`  | ruleId, severity, title, description, status, createdAt |
| `Session`  | id, startedAt (agent memory)                            |
| `Note`     | text, createdAt (episodic memory per user)              |

Relationship types:

| Type              | From → To              | Meaning                              |
|-------------------|------------------------|--------------------------------------|
| `DEFINES`         | File → Function/Class  | file defines symbol                  |
| `CALLS`           | Function → Function    | call edge (blast-radius backbone)    |
| `IMPORTS`         | File → Import          | module dependency                    |
| `AUTHORED`        | Author → Commit        | authorship                           |
| `TOUCHED`         | Commit → File          | commit modified file                 |
| `FLAGGED_IN`      | Finding → Function/File| where the finding lives              |
| `REACHES`         | Finding → Function     | blast-radius: affected downstream    |
| `OWNS`            | Author → File          | primary owner (most touches)         |
| `REMEMBERS`       | Session → Note/Finding | cross-session agent memory           |

Blast radius = variable-length `CALLS` traversal downstream from the flagged
node; impact score = reachability count weighted by PageRank/centrality of
affected nodes (FalkorDB graph algorithms exposed as agent tools).

## 3. Agent tool design

| Tool | Input | Does |
|------|-------|------|
| `cypher_query` | cypher string, params | Read-only Cypher against the repo graph; returns rows. Guard: write ops rejected. |
| `blast_radius` | findingId, maxDepth | Traverses `CALLS` downstream from the flagged node; returns affected nodes + path edges for visualization. |
| `impact_rank` | — | Scores all open findings by blast-radius size × severity × centrality; returns ranked list. |
| `owner_of` | nodeId | Walks `TOUCHED`/`AUTHORED` history → top contributors → `OWNS`; returns suggested reviewer. |
| `mark_fixed` | findingId, commitSha | Updates `Finding.status`; writes a `Note` so the agent remembers across sessions. |
| `recall` | userQuery | Searches past `Note`/`Session` nodes (per-user graph) for relevant history. |

Safety: Cypher tool is read-only; all writes go through the typed tools.

## 4. Track mapping

- **Track 01 — Agents That Act on Connected Data** (primary): the whole
  loop — multi-hop `CALLS` reasoning, graph algorithms as tools, findings
  ranked and acted on (fix PR draft / reviewer suggestion), explainable
  path per finding.
- **Track 02 — Agent Memory and Coordination**: per-user isolated graphs;
  `Session`/`Note` episodic memory; finding status tracked across sessions
  ("flagged Tuesday, fixed Thursday"); `recall` tool grounds follow-ups.
- **Track 03 — Company Brain**: `OWNS` edges answer "who owns this code /
  who should review"; commit history traces decisions to people; scales to
  multi-repo in stretch goals.

Side prizes: blog post → AirPods 5 (write Day 4); top-50 → t-shirts.

## 5. Day-by-day slice plan (Oct 15–18)

**Day 1 — Ingestion (must be demoable on a real repo by EOD)**
- Clone + tree-sitter parse for JS/TS → `File`/`Function`/`CALLS`/`IMPORTS`.
- Commit/author history → `Commit`/`Author`/`TOUCHED`.
- One graph per repo; verify in FalkorDB Browser. Slice demo: graph stats.

**Day 2 — Detection + agent**
- Seed detection rules (5–8 patterns) → `Finding` nodes.
- `blast_radius` + `impact_rank` tools; agent loop with `cypher_query`.
- Memory: `Session`/`Note`, `mark_fixed`, `recall`. Slice demo: ranked findings in terminal/API.

**Day 3 — UI + deploy**
- React: findings list ranked by impact → click → path visualization lights up.
- Chat: "what breaks if I change X?" with Cypher + path shown.
- Deploy live (server Render/Railway, client Vercel). Slice demo: live URL.

**Day 4 — Demo video + blog + submit**
- 2–3 min demo video (problem → scan → blast radius viz → fix flow).
- Blog post (AirPods side prize).
- WeMakeDevs submission: repo link, live URL, video, writeup. Submit before
  11:59 PM IST Oct 18.

Stretch (only if ahead): multi-language parsing, PR-review mode, multi-repo org view.

## 6. Demo script outline

1. Hook (15s): "A one-line secret in the wrong file can compromise your whole app — but which files actually matter?"
2. Scan (30s): paste repo URL → agent ingests → graph builds (timelapse).
3. Findings (45s): ranked list — "7 findings, 2 critical by blast radius, not by gut feel."
4. Trace (45s): click top finding → call-graph path lights up source→sink; show the Cypher behind it.
5. Memory + ownership (30s): "flagged Tuesday, still open" + "suggested reviewer: who owns this file."
6. Close (15s): live URL + repo link + "built on FalkorDB in 4 days."
