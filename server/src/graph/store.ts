// GraphStore abstraction — the seam between the ingestion pipeline and the
// graph backend. Day 1 ships two implementations:
//   - InMemoryGraphStore (graph/memory.ts): default for local dev and tests.
//   - CypherGraphStore   (graph/cypher.ts): generates REAL parameterized
//     Cypher for FalkorDB (one graph per repo via FalkorDB multigraph) and
//     executes it when FALKORDB_URL is set and the connection succeeds.
//
// HONEST STATUS (Day 1, 2026-10-15): live FalkorDB execution is implemented
// but UNVERIFIED — this environment cannot open raw TCP connections, so the
// FalkorDB Cloud instance (FALKORDB_URL in server/.env) is unreachable from
// here. The Cypher statements it generates are real and unit-tested; the
// in-memory store proves the graph model end to end.

import type { EdgeType, GraphEdge, GraphNode, GraphStats } from './types.js';

export interface NeighborsOptions {
  type?: EdgeType;
  direction?: 'out' | 'in' | 'both';
}

export interface GraphStore {
  readonly kind: 'memory' | 'cypher';

  upsertNode(node: GraphNode): Promise<void>;
  addEdge(edge: GraphEdge): Promise<void>;

  getNode(id: string): Promise<GraphNode | undefined>;
  neighbors(id: string, opts?: NeighborsOptions): Promise<GraphNode[]>;
  stats(): Promise<GraphStats>;

  close(): Promise<void>;
}
