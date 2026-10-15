# BlastRadius

**AI agent that finds risky code and traces its blast radius through your codebase graph.**

Graph Hacks 2026 entry — *Graph Hacks: Context for AI Agents* by WeMakeDevs × FalkorDB
([event page](https://wemakedevs.org/hackathons/falkordb)).

## Vision

Point BlastRadius at any GitHub repo. It builds a code graph in FalkorDB
(files, functions, imports, commits, authors), hunts risky code patterns
(hardcoded secrets, unsafe eval, SQL string building, …), traces each
finding's blast radius through the call graph, and ranks what to fix first.
Every finding shows the exact path — tainted source to sink — so the agent's
reasoning is fully explainable.

Entering all three tracks:

- **Track 01 — Agents That Act on Connected Data:** scan → trace → rank → act.
- **Track 02 — Agent Memory and Coordination:** findings remembered across sessions; fixed status tracked over time.
- **Track 03 — Company Brain:** who owns the vulnerable code; who should review the fix.

> ⚠️ Event rule: the submission and its main FalkorDB implementation must be
> new work completed during the event (Oct 15–18, 2026). Scaffold and planning
> predate the event; all domain logic below was built Oct 15.
> See [PLAN.md](./PLAN.md).

## Day 1 — Ingestion pipeline ✅ (built Oct 15, 2026)

`npm run scan -- <repo-url-or-local-path>` clones (if URL), parses JS/TS with
tree-sitter (WASM, no native builds), ingests git history, and writes the
graph:

- **Nodes:** `File` (path, language, loc), `Function` (name, qualifiedName,
  file, lines), `Class`, `Import` (module, imported names), `Commit`, `Author`
- **Edges:** `DEFINES`, `CALLS` (resolved within the repo, cross-file via
  imports), `IMPORTS`, `AUTHORED`, `TOUCHED`, `OWNS` (most-touches-wins)
- Prints a stats table; writes `server/.scan-cache/<repo>.json` served by
  `GET /api/stats?repo=<name>` (minimal Day 1 endpoint)
- 28 Vitest tests green; `tsc --noEmit` clean

### FalkorDB status — read this before judging "live"

The `CypherGraphStore` (`server/src/graph/cypher.ts`) generates **real
parameterized Cypher** (`MERGE`/`MATCH`, one graph per repo via FalkorDB
multigraph) and executes it through the official `falkordb` Node driver when
`FALKORDB_URL` is set (accepts `redis://`, `falkor://`, `rediss://`).
Statement generation is unit-tested.

**Live execution is UNVERIFIED as of Day 1:** this dev environment cannot open
raw TCP connections (runtime restriction), so the FalkorDB Cloud instance is
unreachable from here. A failed connection is deliberately NON-fatal — the
scanner logs `live FalkorDB unreachable from this environment; using
in-memory store` and completes the scan against the in-memory store. Live
verification happens once the environment allows TCP; no code changes needed
— just set `FALKORDB_URL` and re-run.

## Local setup (scaffold)

Prerequisites: Node 20+, Docker.

```bash
# 1. Start FalkorDB
docker compose up -d falkordb

# 2. Server
cd server
cp .env.example .env   # fill in values; never commit .env
npm install
npm run dev            # http://localhost:4000/health

# 3. Client
cd ../client
npm install
npm run dev            # http://localhost:5173
```

FalkorDB browser UI: http://localhost:3000

## Stack

- Server: Node 20 + TypeScript + Express (→ Render/Railway at event time)
- Client: Vite + React 18 + TypeScript + Tailwind (→ Vercel at event time)
- Graph: FalkorDB (Docker locally)
- Agent: LLM with tool calling (wired during the event)

## License

MIT
