// Agent tool tests: blast_radius, impact_rank, cypher_query guard, owner_of,
// mark_fixed, recall — all against InMemoryGraphStore (no network).
// Run: node node_modules/vitest/vitest.mjs run test/tools.test.ts

import { describe, expect, it } from 'vitest';
import { InMemoryGraphStore } from '../src/graph/memory.js';
import type { GraphNode } from '../src/graph/types.js';
import {
  assertReadOnlyCypher,
  blast_radius,
  cypher_query,
  impact_rank,
  mark_fixed,
  owner_of,
  recall,
} from '../src/agent/tools.js';

const fileNode = (p: string): GraphNode => ({
  id: `file:${p}`,
  label: 'File',
  props: { path: p, language: 'javascript', loc: 10 },
});

const fnNode = (p: string, name: string): GraphNode => ({
  id: `fn:${p}:${name}#1`,
  label: 'Function',
  props: { name, qualifiedName: name, file: p, startLine: 1, endLine: 5 },
});

const findingNode = (
  id: string,
  severity: 'critical' | 'high' | 'medium' | 'low',
  status = 'open',
): GraphNode => ({
  id,
  label: 'Finding',
  props: {
    ruleId: 'test-rule',
    severity,
    title: `Finding ${id}`,
    description: 'test',
    file: 'a.js',
    line: 1,
    status,
    createdAt: new Date().toISOString(),
  },
});

/**
 * Call graph:
 *   main -> a -> b -> c
 *   main -> d,  a -> d
 * (c and d are leaves)
 */
async function buildCallGraph(): Promise<InMemoryGraphStore> {
  const store = new InMemoryGraphStore();
  for (const p of ['a.js', 'b.js']) await store.upsertNode(fileNode(p));
  for (const [p, name] of [
    ['a.js', 'main'],
    ['a.js', 'a'],
    ['b.js', 'b'],
    ['b.js', 'c'],
    ['a.js', 'd'],
  ] as const) {
    await store.upsertNode(fnNode(p, name));
  }
  const calls: [string, string][] = [
    ['main', 'a'],
    ['a', 'b'],
    ['b', 'c'],
    ['main', 'd'],
    ['a', 'd'],
  ];
  for (const [from, to] of calls) {
    const fromFile = from === 'b' || from === 'c' ? 'b.js' : 'a.js';
    const toFile = to === 'b' || to === 'c' ? 'b.js' : 'a.js';
    await store.addEdge({
      from: `fn:${fromFile}:${from}#1`,
      to: `fn:${toFile}:${to}#1`,
      type: 'CALLS',
    });
  }
  return store;
}

async function flag(store: InMemoryGraphStore, findingId: string, fnName: string): Promise<void> {
  const p = fnName === 'b' || fnName === 'c' ? 'b.js' : 'a.js';
  await store.addEdge({ from: findingId, to: `fn:${p}:${fnName}#1`, type: 'FLAGGED_IN' });
}

describe('blast_radius', () => {
  it('returns exact reachable sets at depths 1/2/3', async () => {
    const store = await buildCallGraph();
    const f = findingNode('finding:1', 'high');
    await store.upsertNode(f);
    await flag(store, f.id, 'a');

    const d1 = await blast_radius(store, f.id, 1);
    expect(new Set(d1.nodes.map((n) => n.id))).toEqual(
      new Set(['fn:a.js:d#1', 'fn:b.js:b#1']),
    );

    const d2 = await blast_radius(store, f.id, 2);
    expect(new Set(d2.nodes.map((n) => n.id))).toEqual(
      new Set(['fn:a.js:d#1', 'fn:b.js:b#1', 'fn:b.js:c#1']),
    );

    // Depth 3 adds nothing — c and d are leaves.
    const d3 = await blast_radius(store, f.id, 3);
    expect(new Set(d3.nodes.map((n) => n.id))).toEqual(
      new Set(['fn:a.js:d#1', 'fn:b.js:b#1', 'fn:b.js:c#1']),
    );
  });

  it('returns path edges for visualization plus the Cypher', async () => {
    const store = await buildCallGraph();
    const f = findingNode('finding:1', 'high');
    await store.upsertNode(f);
    await flag(store, f.id, 'a');

    const r = await blast_radius(store, f.id, 1);
    expect(r.edges).toContainEqual({ from: 'fn:a.js:a#1', to: 'fn:b.js:b#1' });
    expect(r.edges).toContainEqual({ from: 'fn:a.js:a#1', to: 'fn:a.js:d#1' });
    expect(r.cypher).toContain('CALLS*1..1');
    expect(r.flagged?.id).toBe('fn:a.js:a#1');
  });

  it('throws for unknown finding ids', async () => {
    const store = await buildCallGraph();
    await expect(blast_radius(store, 'finding:nope', 2)).rejects.toThrow('no Finding');
  });
});

describe('impact_rank', () => {
  it('orders by blast size x severity x centrality, skipping fixed findings', async () => {
    const store = await buildCallGraph();
    // F1 high, flagged in a -> blast {b, d, c} (3)
    // F2 critical, flagged in c -> blast {} (0)
    // F3 medium, flagged in b -> blast {c} (1)
    const f1 = findingNode('finding:f1', 'high');
    const f2 = findingNode('finding:f2', 'critical');
    const f3 = findingNode('finding:f3', 'medium');
    for (const f of [f1, f2, f3]) await store.upsertNode(f);
    await flag(store, f1.id, 'a');
    await flag(store, f2.id, 'c');
    await flag(store, f3.id, 'b');

    const ranked = await impact_rank(store);
    expect(ranked.map((r) => r.finding.id)).toEqual([f1.id, f3.id, f2.id]);
    expect(ranked[0].blastSize).toBe(3);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);

    // Fixed findings drop out of the ranking.
    await mark_fixed(store, f1.id);
    const reranked = await impact_rank(store);
    expect(reranked.map((r) => r.finding.id)).toEqual([f3.id, f2.id]);
  });
});

describe('cypher_query guard', () => {
  it('accepts read queries (any case, leading comments)', () => {
    expect(() => assertReadOnlyCypher('MATCH (n:Finding) RETURN n')).not.toThrow();
    expect(() => assertReadOnlyCypher('match (n) return n')).not.toThrow();
    expect(() => assertReadOnlyCypher('OPTIONAL MATCH (n) RETURN n')).not.toThrow();
    expect(() => assertReadOnlyCypher('WITH 1 AS x RETURN x')).not.toThrow();
    expect(() => assertReadOnlyCypher('CALL db.labels()')).not.toThrow();
    expect(() => assertReadOnlyCypher('// a comment\nMATCH (n) RETURN n')).not.toThrow();
    // A write keyword inside a string literal is not a write.
    expect(() => assertReadOnlyCypher(`MATCH (n) WHERE n.x = 'delete' RETURN n`)).not.toThrow();
  });

  it('rejects writes and non-reads', () => {
    for (const q of [
      'CREATE (n:Finding)',
      'MATCH (n) SET n.x = 1 RETURN n',
      'MATCH (n) DELETE n',
      'MATCH (n) DETACH DELETE n',
      'MERGE (n:Finding {id: 1})',
      'MATCH (n)-[r]->(m) REMOVE r.x',
      '',
      'EXPLAIN MATCH (n) RETURN n',
    ]) {
      expect(() => assertReadOnlyCypher(q), q).toThrow();
    }
  });

  it('refuses to execute on the in-memory store', async () => {
    const store = new InMemoryGraphStore();
    await expect(cypher_query(store, 'MATCH (n) RETURN n')).rejects.toThrow(
      'live FalkorDB',
    );
  });
});

describe('owner_of', () => {
  async function buildHistory(): Promise<InMemoryGraphStore> {
    const store = new InMemoryGraphStore();
    await store.upsertNode(fileNode('src/f1.js'));
    await store.upsertNode(fnNode('src/f1.js', 'work'));
    await store.addEdge({ from: 'file:src/f1.js', to: 'fn:src/f1.js:work#1', type: 'DEFINES' });
    for (const sha of ['c1', 'c2', 'c3']) {
      await store.upsertNode({ id: `commit:${sha}`, label: 'Commit', props: { sha } });
      await store.addEdge({ from: `commit:${sha}`, to: 'file:src/f1.js', type: 'TOUCHED' });
    }
    await store.upsertNode({ id: 'author:alice', label: 'Author', props: { name: 'Alice', email: 'alice@x.com' } });
    await store.upsertNode({ id: 'author:bob', label: 'Author', props: { name: 'Bob', email: 'bob@x.com' } });
    // Alice authored c1, c2; Bob authored c3.
    await store.addEdge({ from: 'author:alice', to: 'commit:c1', type: 'AUTHORED' });
    await store.addEdge({ from: 'author:alice', to: 'commit:c2', type: 'AUTHORED' });
    await store.addEdge({ from: 'author:bob', to: 'commit:c3', type: 'AUTHORED' });
    return store;
  }

  it('suggests the top committer for a file', async () => {
    const store = await buildHistory();
    const owner = await owner_of(store, 'file:src/f1.js');
    expect(owner).toMatchObject({ name: 'Alice', email: 'alice@x.com', touches: 2, totalCommits: 3 });
  });

  it('resolves a function node to its file first', async () => {
    const store = await buildHistory();
    const owner = await owner_of(store, 'fn:src/f1.js:work#1');
    expect(owner?.email).toBe('alice@x.com');
  });

  it('returns null without history', async () => {
    const store = new InMemoryGraphStore();
    await store.upsertNode(fileNode('src/lonely.js'));
    expect(await owner_of(store, 'file:src/lonely.js')).toBeNull();
    expect(await owner_of(store, 'nope')).toBeNull();
  });
});

describe('mark_fixed + recall', () => {
  it('marks a finding fixed and remembers it in a note', async () => {
    const store = new InMemoryGraphStore();
    const f = findingNode('finding:1', 'high');
    await store.upsertNode(f);
    await store.upsertNode({
      id: 'session:1',
      label: 'Session',
      props: { startedAt: new Date().toISOString() },
    });

    const updated = await mark_fixed(store, f.id, 'abc123');
    expect(updated.props['status']).toBe('fixed');
    expect(updated.props['fixCommit']).toBe('abc123');
    expect((await store.getNode(f.id))?.props['status']).toBe('fixed');

    // A note was written and linked from the session.
    const notes = await store.findNodes('Note');
    expect(notes).toHaveLength(1);
    expect(String(notes[0].props['text'])).toContain('abc123');
    const remembered = await store.neighbors('session:1', { type: 'REMEMBERS', direction: 'out' });
    expect(remembered.map((n) => n.id)).toEqual([notes[0].id]);

    // recall finds it by keyword.
    const hits = await recall(store, 'marked finding fixed');
    expect(hits.map((n) => n.id)).toEqual([notes[0].id]);
    expect(await recall(store, 'definitely not present xyz')).toEqual([]);
  });

  it('throws for unknown findings', async () => {
    const store = new InMemoryGraphStore();
    await expect(mark_fixed(store, 'finding:nope')).rejects.toThrow('no Finding');
  });
});
