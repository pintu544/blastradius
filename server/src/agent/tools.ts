// Agent tools for BlastRadius Day 2 (PLAN.md §3).
//
// Written against the GraphStore interface: every tool works on
// InMemoryGraphStore. CypherGraphStore paths generate REAL Cypher and execute
// it when connected (throwing a clear, non-fatal error when not). No LLM
// dependency — the Day 2 loop (agent/loop.ts) is a deterministic orchestrator;
// LLM tool-calling arrives later and will call these same functions.

import { CypherGraphStore } from '../graph/cypher.js';
import type { GraphStore } from '../graph/store.js';
import {
  SEVERITY_WEIGHT,
  type FindingSeverity,
  type GraphNode,
} from '../graph/types.js';

// ---------------------------------------------------------------------------
// Shared graph walk
// ---------------------------------------------------------------------------

export interface ReachResult {
  /** Affected function nodes (the start node itself is excluded). */
  nodes: GraphNode[];
  /** Path edges for visualization: { from, to } id pairs. */
  edges: { from: string; to: string }[];
}

/**
 * BFS downstream over CALLS edges up to maxDepth. Only Function nodes are
 * collected (files/classes are context, not blast radius).
 */
export async function reachableFunctions(
  store: GraphStore,
  startId: string,
  maxDepth: number,
): Promise<ReachResult> {
  const visited = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: { from: string; to: string }[] = [];
  let frontier = [startId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const out = await store.neighbors(id, { type: 'CALLS', direction: 'out' });
      for (const n of out) {
        if (n.label !== 'Function' || visited.has(n.id)) continue;
        visited.add(n.id);
        nodes.push(n);
        edges.push({ from: id, to: n.id });
        next.push(n.id);
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// blast_radius
// ---------------------------------------------------------------------------

export interface BlastRadiusResult extends ReachResult {
  finding: GraphNode;
  flagged: GraphNode | undefined;
  depth: number;
  /** The equivalent read-only Cypher (explainability for the demo/UI). */
  cypher: string;
}

export function blastRadiusCypher(maxDepth: number): string {
  return (
    'MATCH (f:Finding {id: $findingId})-[:FLAGGED_IN]->(src) ' +
    `MATCH p = (src)-[:CALLS*1..${maxDepth}]->(affected:Function) ` +
    'RETURN affected, relationships(p) AS path'
  );
}

export async function blast_radius(
  store: GraphStore,
  findingId: string,
  maxDepth = 5,
): Promise<BlastRadiusResult> {
  const finding = await store.getNode(findingId);
  if (!finding || finding.label !== 'Finding') {
    throw new Error(`blast_radius: no Finding node with id "${findingId}"`);
  }
  const flagged =
    (await store.neighbors(findingId, { type: 'FLAGGED_IN', direction: 'out' }))[0];
  if (!flagged) {
    return { finding, flagged: undefined, nodes: [], edges: [], depth: maxDepth, cypher: blastRadiusCypher(maxDepth) };
  }
  const { nodes, edges } = await reachableFunctions(store, flagged.id, maxDepth);
  return { finding, flagged, nodes, edges, depth: maxDepth, cypher: blastRadiusCypher(maxDepth) };
}

// ---------------------------------------------------------------------------
// impact_rank
// ---------------------------------------------------------------------------

export interface RankedFinding {
  finding: GraphNode;
  severity: FindingSeverity;
  blastSize: number;
  /** Mean CALLS degree (in+out) of the affected functions. */
  avgDegree: number;
  score: number;
}

/**
 * Score open findings by blast-radius size × severity weight × centrality.
 * Centrality here is deliberately simple: mean CALLS degree of the affected
 * functions (a finding that can reach hub functions matters more).
 */
export async function impact_rank(store: GraphStore): Promise<RankedFinding[]> {
  const findings = (await store.findNodes('Finding')).filter(
    (f) => f.props['status'] !== 'fixed',
  );
  const ranked: RankedFinding[] = [];
  for (const finding of findings) {
    const severity = (finding.props['severity'] as FindingSeverity) ?? 'low';
    const { nodes } = await blast_radius(store, finding.id, 5);
    let degreeSum = 0;
    for (const n of nodes) {
      degreeSum += (await store.neighbors(n.id, { type: 'CALLS', direction: 'both' })).length;
    }
    const avgDegree = nodes.length > 0 ? degreeSum / nodes.length : 0;
    const score =
      Math.round(nodes.length * (SEVERITY_WEIGHT[severity] ?? 1) * (1 + avgDegree) * 100) / 100;
    ranked.push({ finding, severity, blastSize: nodes.length, avgDegree: Math.round(avgDegree * 100) / 100, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

// ---------------------------------------------------------------------------
// cypher_query (guarded, read-only)
// ---------------------------------------------------------------------------

const READ_START =
  /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\s*(MATCH|OPTIONAL\s+MATCH|WITH|RETURN|CALL)\b/i;
const WRITE_KEYWORD = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP)\b/i;
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/**
 * Reject anything that isn't a read query. Fail-closed: string literals are
 * stripped before the write-keyword scan so `RETURN 'delete'` is allowed, but
 * exotic shapes (e.g. CALL { <write> }) are still rejected by the keyword
 * backstop. Documented limitation, not a sandbox escape hatch.
 */
export function assertReadOnlyCypher(cypher: string): void {
  if (typeof cypher !== 'string' || !cypher.trim()) {
    throw new Error('cypher_query: empty query');
  }
  if (!READ_START.test(cypher)) {
    throw new Error(
      'cypher_query: only read queries are allowed — must start with MATCH, OPTIONAL MATCH, WITH, RETURN or CALL',
    );
  }
  const dequoted = cypher.replace(STRING_LITERAL, "''");
  if (WRITE_KEYWORD.test(dequoted)) {
    throw new Error(
      'cypher_query: write keywords are not allowed (CREATE / MERGE / DELETE / DETACH / SET / REMOVE / DROP)',
    );
  }
}

/**
 * Execute a guarded read-only Cypher query. Requires a live FalkorDB
 * connection — the in-memory store has no Cypher engine, so this throws a
 * clear error there instead of pretending.
 */
export async function cypher_query(
  store: GraphStore,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<unknown[]> {
  assertReadOnlyCypher(cypher);
  if (store.kind !== 'cypher') {
    throw new Error(
      'cypher_query needs a live FalkorDB connection (FALKORDB_URL); the in-memory store cannot execute Cypher',
    );
  }
  return (store as CypherGraphStore).readQuery(cypher, params);
}

// ---------------------------------------------------------------------------
// owner_of
// ---------------------------------------------------------------------------

export interface OwnerInfo {
  name: string;
  email: string;
  /** Commits by this author touching the file. */
  touches: number;
  /** Total commits touching the file. */
  totalCommits: number;
  via: string;
}

/**
 * Suggested reviewer for a node: the top committer on the owning file,
 * derived from TOUCHED/AUTHORED history (PLAN.md §3 owner_of).
 */
export async function owner_of(store: GraphStore, nodeId: string): Promise<OwnerInfo | null> {
  const node = await store.getNode(nodeId);
  if (!node) return null;
  let fileId: string | null = null;
  if (node.label === 'File') {
    fileId = node.id;
  } else {
    const parents = await store.neighbors(nodeId, { type: 'DEFINES', direction: 'in' });
    fileId = parents.find((p) => p.label === 'File')?.id ?? null;
  }
  if (!fileId) return null;

  const commits = await store.neighbors(fileId, { type: 'TOUCHED', direction: 'in' });
  if (commits.length === 0) return null;
  const tally = new Map<string, { name: string; email: string; count: number }>();
  for (const commit of commits) {
    const authors = await store.neighbors(commit.id, { type: 'AUTHORED', direction: 'in' });
    for (const a of authors) {
      const email = String(a.props['email'] ?? '');
      if (!email) continue;
      const cur = tally.get(email) ?? {
        name: String(a.props['name'] ?? email),
        email,
        count: 0,
      };
      cur.count++;
      tally.set(email, cur);
    }
  }
  if (tally.size === 0) return null;
  const top = [...tally.values()].sort((a, b) => b.count - a.count)[0];
  const file = String((await store.getNode(fileId))?.props['path'] ?? fileId);
  return {
    name: top.name,
    email: top.email,
    touches: top.count,
    totalCommits: commits.length,
    via: `${top.count} of ${commits.length} commits touching ${file}`,
  };
}

// ---------------------------------------------------------------------------
// mark_fixed
// ---------------------------------------------------------------------------

/**
 * Mark a finding fixed and write a Note so the agent remembers across
 * sessions (PLAN.md §3). The note is linked from the latest Session node.
 */
export async function mark_fixed(
  store: GraphStore,
  findingId: string,
  commitSha?: string,
): Promise<GraphNode> {
  const node = await store.getNode(findingId);
  if (!node || node.label !== 'Finding') {
    throw new Error(`mark_fixed: no Finding node with id "${findingId}"`);
  }
  const now = new Date().toISOString();
  const updated: GraphNode = {
    ...node,
    props: {
      ...node.props,
      status: 'fixed',
      fixedAt: now,
      ...(commitSha ? { fixCommit: commitSha } : {}),
    },
  };
  await store.upsertNode(updated);

  const safeId = findingId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const noteId = `note:mark-fixed:${Date.now()}:${safeId}`;
  const title = typeof node.props['title'] === 'string' ? node.props['title'] : findingId;
  await store.upsertNode({
    id: noteId,
    label: 'Note',
    props: {
      text:
        `Marked finding "${title}" (${findingId}) as fixed` +
        (commitSha ? ` in commit ${commitSha}.` : '.'),
      createdAt: now,
    },
  });
  const sessions = await store.findNodes('Session');
  sessions.sort((a, b) =>
    String(a.props['startedAt'] ?? '').localeCompare(String(b.props['startedAt'] ?? '')),
  );
  const latest = sessions[sessions.length - 1];
  if (latest) {
    await store.addEdge({ from: latest.id, to: noteId, type: 'REMEMBERS' });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

/**
 * Keyword search over Note nodes (episodic memory). Scores by token overlap,
 * newest first on ties. Deliberately simple — a full-text index arrives with
 * FalkorDB-backed memory later.
 */
export async function recall(
  store: GraphStore,
  query: string,
  limit = 5,
): Promise<GraphNode[]> {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  const notes = await store.findNodes('Note');
  const scored = notes
    .map((n) => {
      const text = String(n.props['text'] ?? '').toLowerCase();
      let score = 0;
      for (const t of tokens) if (text.includes(t)) score++;
      return { n, score };
    })
    .filter((s) => s.score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      String(b.n.props['createdAt'] ?? '').localeCompare(String(a.n.props['createdAt'] ?? '')),
  );
  return scored.slice(0, limit).map((s) => s.n);
}
