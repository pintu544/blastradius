# BlastRadius — Demo Video Narration Script

**Target:** 2:30 at a natural, unhurried pace (~370 words).
**Tone:** conversational, like explaining it to a senior dev friend.
**Before recording:** re-run your demo scan and check the numbers in beat 2 —
they came from the Oct 15 production scan (187 functions, 172 call edges,
43 findings, under 7 seconds). If your demo repo gives different numbers,
swap them in. Pre-start the scan if the clone takes more than ~10s on camera.

---

## Beat 1 — Hook (0:00–0:20)

> A hardcoded API key in a utility file. A SQL query built with string
> concatenation. Most scanners will flag these — and then drown you in a
> list of three hundred warnings.
>
> BlastRadius asks a different question: if *this* line breaks, what breaks
> *with* it?

**On screen:** landing page, https://blastradius-eosin.vercel.app.

## Beat 2 — Scan (0:20–0:55)

> Paste any JavaScript or TypeScript repo URL, hit scan. BlastRadius clones
> it, parses every file, and builds a code knowledge graph — files,
> functions, call edges, imports — layered with git history.
>
> On a real scan: 187 functions, 172 call edges, fully mapped in under seven
> seconds.

**On screen:** paste repo URL → scan bar → graph stats appear.

## Beat 3 — Findings, ranked by blast radius (0:55–1:35)

> Eight detection rules run over the graph: hardcoded secrets, dangerous
> eval, shell command injection, SQL string concatenation, insecure
> randomness, unsafe innerHTML, weak hashes, and security TODOs.
>
> But the list isn't sorted by severity alone. It's ranked by blast radius —
> how much of your app each finding can actually reach. The scariest finding
> is the one with the longest fuse.

**On screen:** ranked findings list with severity badges and ownership.

## Beat 4 — Trace the blast (1:35–2:10)

> Click the top finding and the call graph lights up — the exact path from
> the vulnerable line to everything it can touch. Source to sink, no
> guessing.
>
> And every finding shows its work: the Cypher query that produced it, right
> there in the explainability panel.

**On screen:** click finding → blast-radius graph view, path highlighted →
Cypher panel.

## Beat 5 — Memory and ownership (2:10–2:30)

> Findings persist across scans — flag something today, it's still open next
> week until someone marks it fixed. And from git history, BlastRadius tells
> you who actually owns the file, so the fix lands with the right person.

**On screen:** a finding marked fixed; ownership/"suggested reviewer" line.

## Beat 6 — The reverse question + close (2:30–2:50)

> And then there's the reverse question. Type "what breaks if I change X?"
> and the chat traces the impact *before* you touch the code.
>
> BlastRadius — know your blast radius before the blast. Live demo and repo
> linked below.

**On screen:** "what breaks if I change X?" chat → live URL + repo link.

---

## Recording notes

- Don't narrate the clone wait — pre-scan, then cut to results.
- The Cypher panel is the judge-impressing moment; give it a full 5 seconds
  of silence on screen in beat 4.
- Honesty note: the demo runs the in-memory graph backend (the FalkorDB
  Cloud connection is still pending a password). Don't claim "running on
  FalkorDB Cloud" on camera — "code knowledge graph with Cypher
  explainability" is the accurate line.
