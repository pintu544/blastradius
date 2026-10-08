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
> new work completed during the event (Oct 15–18, 2026). This repo currently
> holds **scaffold + infrastructure + planning only** — no domain logic yet.
> See [PLAN.md](./PLAN.md).

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
