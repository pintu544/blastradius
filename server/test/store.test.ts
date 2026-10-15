// GraphStore tests: in-memory behavior + Cypher statement generation.
// Run: npx vitest run test/store.test.ts

import { describe, expect, it } from 'vitest';
import { CypherGraphStore } from '../src/graph/cypher.js';
import { InMemoryGraphStore } from '../src/graph/memory.js';
import type { GraphEdge, GraphNode } from '../src/graph/types.js';

const fileNode: GraphNode = { id: 'file:src/a.js', label: 'File', props: { path: 'src/a.js' } };
const fnNode: GraphNode = {
  id: 'fn:src/a.js:main#1',
  label: 'Function',
  props: { name: 'main', file: 'src/a.js' },
};
const edge: GraphEdge = { from: fileNode.id, to: fnNode.id, type: 'DEFINES' };

describe('InMemoryGraphStore', () => {
  it('upserts nodes and links edges', async () => {
    const store = new InMemoryGraphStore();
    await store.upsertNode(fileNode);
    await store.upsertNode(fnNode);
    await store.addEdge(edge);

    expect(await store.getNode(fileNode.id)).toMatchObject({ label: 'File' });
    const neighbors = await store.neighbors(fileNode.id);
    expect(neighbors.map((n) => n.id)).toEqual([fnNode.id]);
  });

  it('merges props on re-upsert and dedupes edges', async () => {
    const store = new InMemoryGraphStore();
    await store.upsertNode(fileNode);
    await store.upsertNode({ ...fileNode, props: { path: 'src/a.js', loc: 42 } });
    expect((await store.getNode(fileNode.id))!.props).toMatchObject({ loc: 42 });

    await store.upsertNode(fnNode);
    await store.addEdge(edge);
    await store.addEdge(edge); // duplicate — ignored
    const stats = await store.stats();
    expect(stats.definesEdges).toBe(1);
  });

  it('filters neighbors by type and direction', async () => {
    const store = new InMemoryGraphStore();
    const other: GraphNode = { id: 'fn:src/a.js:help#5', label: 'Function', props: { name: 'help' } };
    await store.upsertNode(fileNode);
    await store.upsertNode(fnNode);
    await store.upsertNode(other);
    await store.addEdge(edge);
    await store.addEdge({ from: fnNode.id, to: other.id, type: 'CALLS' });

    expect(await store.neighbors(fnNode.id, { type: 'CALLS', direction: 'out' })).toHaveLength(1);
    expect(await store.neighbors(fnNode.id, { type: 'CALLS', direction: 'in' })).toHaveLength(0);
    expect(await store.neighbors(fnNode.id, { direction: 'both' })).toHaveLength(2);
  });

  it('counts stats per label and edge type', async () => {
    const store = new InMemoryGraphStore();
    await store.upsertNode(fileNode);
    await store.upsertNode(fnNode);
    await store.addEdge(edge);
    await store.addEdge({ from: fnNode.id, to: fnNode.id, type: 'CALLS' });
    const stats = await store.stats();
    expect(stats.files).toBe(1);
    expect(stats.functions).toBe(1);
    expect(stats.definesEdges).toBe(1);
    expect(stats.callsEdges).toBe(1);
  });

  it('ignores edges that reference missing nodes', async () => {
    const store = new InMemoryGraphStore();
    await store.upsertNode(fileNode);
    await store.addEdge({ from: fileNode.id, to: 'fn:nope', type: 'DEFINES' });
    expect((await store.stats()).definesEdges).toBe(0);
  });
});

describe('CypherGraphStore', () => {
  it('sanitizes the repo name into a FalkorDB graph name', () => {
    const store = new CypherGraphStore('My Cool Repo!', undefined);
    expect(store.graphName).toBe('blastradius_my_cool_repo');
  });

  it('generates real parameterized MERGE statements for nodes', async () => {
    const store = new CypherGraphStore('demo', undefined);
    await store.upsertNode(fnNode);
    expect(store.statements).toHaveLength(1);
    const [stmt] = store.statements;
    expect(stmt.cypher).toBe('MERGE (n:`Function` {id: $id}) SET n += $props');
    expect(stmt.params['id']).toBe(fnNode.id);
    expect(stmt.params['props']).toMatchObject({ name: 'main' });
  });

  it('generates MATCH+MERGE statements for edges', async () => {
    const store = new CypherGraphStore('demo', undefined);
    await store.addEdge({ from: 'a', to: 'b', type: 'CALLS', props: { line: 3 } });
    const [stmt] = store.statements;
    expect(stmt.cypher).toBe(
      'MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:`CALLS`]->(b) SET r += $props',
    );
    expect(stmt.params).toMatchObject({ from: 'a', to: 'b', props: { line: 3 } });
  });

  it('derives stats from generated statements without a live server', async () => {
    const store = new CypherGraphStore('demo', undefined);
    await store.upsertNode(fileNode);
    await store.upsertNode(fnNode);
    await store.addEdge(edge);
    await store.addEdge({ from: fnNode.id, to: fnNode.id, type: 'CALLS' });
    const stats = await store.stats();
    expect(stats.files).toBe(1);
    expect(stats.functions).toBe(1);
    expect(stats.definesEdges).toBe(1);
    expect(stats.callsEdges).toBe(1);
  });

  it('throws a clear error when connecting without FALKORDB_URL', async () => {
    const store = new CypherGraphStore('demo', undefined);
    await expect(store.connect()).rejects.toThrow('FALKORDB_URL is not set');
  });

  it('throws when the server is unreachable (live integration unverified)', async () => {
    // 127.0.0.1:6399 is (almost certainly) not a FalkorDB — this asserts the
    // failure path is loud, not silent. Live execution stays UNVERIFIED until
    // real credentials exist.
    const store = new CypherGraphStore('demo', 'redis://127.0.0.1:6399');
    await expect(store.connect()).rejects.toThrow();
    expect(store.connected).toBe(false);
  }, 15000);

  it('accepts the falkor:// scheme used by FalkorDB Cloud', async () => {
    // Must get PAST URL parsing (scheme accepted) and fail only on TCP.
    const store = new CypherGraphStore('demo', 'falkor://falkordb@127.0.0.1:6399');
    await expect(store.connect()).rejects.toThrow(/unreachable|refused|ECONN/i);
    expect(store.connected).toBe(false);
  }, 15000);

  it('never echoes the URL in parse errors (may contain credentials)', async () => {
    const store = new CypherGraphStore('demo', 'https://user:secret@example.com/db');
    await expect(store.connect()).rejects.toThrow(
      'FALKORDB_URL must be a redis://, falkor://, rediss:// or falkors:// URL',
    );
    await expect(store.connect()).rejects.not.toThrow('secret');
  });

  it('does not crash when the endpoint speaks garbage (probe rejects first)', async () => {
    // Regression test: previously the driver's forwarded 'error' event for a
    // non-RESP endpoint became an *unhandled 'error' event* and killed the
    // whole process. The probe must reject cleanly instead.
    const { createServer } = await import('node:net');
    const server = createServer((socket) => {
      socket.write('mystery-garbage\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const store = new CypherGraphStore('demo', `redis://127.0.0.1:${port}`);
      await expect(store.connect()).rejects.toThrow('did not answer a RESP PING');
      expect(store.connected).toBe(false);
      // If we get here, the process survived — the regression is fixed.
    } finally {
      server.close();
    }
  });
});
