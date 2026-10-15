# "What breaks if I change this?" — I built a blast-radius engine for codebases

*Built for Graph Hacks 2026 (WeMakeDevs x FalkorDB) — repo: [pintu544/blastradius](https://github.com/pintu544/blastradius), live demo: [blastradius-eosin.vercel.app](https://blastradius-eosin.vercel.app)*

Every developer knows the fear. You change one innocent-looking function, and three services away something silently breaks. Code review catches the obvious stuff, but nobody can hold a 500-file call graph in their head. So for Graph Hacks I built **BlastRadius**: paste in a GitHub repo URL, and it tells you exactly what breaks if you touch any function — ranked by real impact, not gut feel.

## How it works

**1. Ingest.** The scanner clones the repo and parses every JS/TS file with tree-sitter (WASM, so no native build pain). It extracts functions — declarations, arrow consts, class methods — plus imports, `require()` calls, and every call edge, resolved across files. Git history comes along too: commits, authors, who touched what, and a derived "who owns this file" edge.

**2. Model.** Everything lands in a property graph: `File` → `DEFINES` → `Function` → `CALLS` → `Function`, with `IMPORTS`, `TOUCHED`, `AUTHORED`, and `OWNS` edges. One isolated graph per repo (FalkorDB multigraph). The schema is backend-agnostic — there's an in-memory store for dev/test and a Cypher-generating store for FalkorDB, so every query the engine runs is real Cypher you can inspect.

**3. Detect.** Eight static rules hunt risky patterns: hardcoded secrets, `eval()` / `new Function()`, shell exec with non-literal args, SQL string concatenation, `Math.random()` for tokens, unsafe `innerHTML`, weak hashes. Each hit becomes a `Finding` node linked to the exact function and line.

**4. Trace & rank.** This is the core. From each finding, the engine walks `CALLS` edges downstream — that's the blast radius. Findings are ranked by blast-radius size × severity × centrality of affected nodes. A critical secret in a dead utility function ranks *below* a medium-severity SQL concat in the function everything calls. That ordering is the whole point: impact, measured.

**5. Explain.** Click a finding and you get the traversed path drawn as a graph, the suggested code owner, and the exact Cypher behind the trace. There's also a chat box: *"what breaks if I change getUser?"* → matched function, downstream impact, and the query, in plain English.

## What surprised me

- **Your own codebase is the best test fixture.** Scanning BlastRadius itself came back clean — which also proved the rules don't false-positive on regex literals that merely *mention* `eval`.
- **The honest fallback matters.** My dev VM couldn't open raw TCP to FalkorDB Cloud (runtime permission), so the store degrades gracefully to in-memory with a clear warning instead of crashing. The deployed server does the same. Every Cypher statement is still unit-tested — the graph logic never depended on a live database to be correct.
- **Ownership is underrated.** "Who should review this?" turned out to be one of the most demoable features — `TOUCHED`/`AUTHORED` history → top contributor per file. Reviewers love it.

## Try it

Live: [blastradius-eosin.vercel.app](https://blastradius-eosin.vercel.app) — paste any public JS/TS repo, hit scan, click the top finding. Or run it locally: `npm run scan -- <repo-url>` prints the ranked findings table in your terminal.

Built Oct 15–18, 2026 for Graph Hacks. If you've ever been bitten by a "trivial" change, this one's for you.
