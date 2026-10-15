// CypherGraphStore — FalkorDB backend for BlastRadius.
//
// Generates REAL parameterized Cypher for every write and, when
// FALKORDB_URL is set, executes it against FalkorDB via the official
// `falkordb` Node driver. One isolated graph per repo via FalkorDB
// multigraph (`db.selectGraph(graphName)`), matching PLAN.md §1.
//
// HONEST STATUS (Day 1, 2026-10-15): the Cypher is real and the driver call
// path is implemented (verified against the driver's own type definitions),
// but live execution is UNVERIFIED — this dev environment cannot open raw
// TCP connections (runtime restriction), so FalkorDB Cloud is unreachable
// from here even with a valid FALKORDB_URL in server/.env. `connect()`
// throws when the server can't be reached; the scanner catches that, logs
// "live FalkorDB unreachable from this environment; using in-memory store",
// and falls back to the in-memory store. Statement generation is covered by
// unit tests in test/store.test.ts. Live verification happens separately
// once the environment allows TCP.

import type { GraphStore, NeighborsOptions } from './store.js';
import {
  emptyStats,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
} from './types.js';

export interface CypherStatement {
  cypher: string;
  params: Record<string, unknown>;
}

// Labels / relationship types come from our own fixed enums, so
// interpolating them into the statement text is safe; all user-controlled
// values travel as parameters.
const NODE_WRITE =
  'MERGE (n:`__LABEL__` {id: $id}) SET n += $props';
const EDGE_WRITE =
  'MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:`__TYPE__`]->(b) SET r += $props';

function sanitizeGraphName(name: string): string {
  // FalkorDB graph names: keep it URL/CLI friendly.
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return `blastradius_${slug || 'repo'}`;
}

function parseConnectionUrl(url: string): { host: string; port: number; tls: boolean } {
  // Accept redis:// (standard), falkor:// (FalkorDB Cloud dashboard format —
  // same RESP protocol underneath), and rediss:// (TLS).
  // The URL itself is never echoed in errors: it may contain credentials.
  const m = /^(redis|falkor|rediss):\/\/(?:[^@]*@)?([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error('FALKORDB_URL must be a redis://, falkor:// or rediss:// URL');
  return { host: m[2], port: m[3] ? Number(m[3]) : 6379, tls: m[1] === 'rediss' };
}

// Minimal structural typing for the driver pieces we use, so the module
// loads without the driver installed until connect() is actually called.
interface DriverGraph {
  query(cypher: string, options?: { params?: Record<string, unknown> }): Promise<unknown>;
}
interface DriverClient {
  selectGraph(graphId: string): DriverGraph;
  close(): Promise<void>;
}

export class CypherGraphStore implements GraphStore {
  readonly kind = 'cypher' as const;
  readonly graphName: string;
  /** Every statement generated — the unit-testable record of all writes. */
  readonly statements: CypherStatement[] = [];
  connected = false;

  private client: DriverClient | null = null;
  private graph: DriverGraph | null = null;
  private nodeCounts = new Map<string, number>();
  private edgeCounts = new Map<EdgeType, number>();

  constructor(repoName: string, private readonly url?: string) {
    this.graphName = sanitizeGraphName(repoName);
  }

  /** Attempt a live connection. Throws when FALKORDB_URL is unset or unreachable. */
  async connect(): Promise<void> {
    if (!this.url) throw new Error('FALKORDB_URL is not set — cannot connect to FalkorDB');
    const { host, port, tls } = parseConnectionUrl(this.url);
    // Dynamic import: the driver is only required when a live connection is attempted.
    const { FalkorDB } = (await import('falkordb')) as {
      FalkorDB: {
        connect(options?: unknown): Promise<DriverClient>;
      };
    };
    this.client = await FalkorDB.connect({
      socket: { host, port, ...(tls ? { tls: true } : {}) },
      connectTimeout: 5000,
    });
    this.graph = this.client.selectGraph(this.graphName);
    // Smoke test so a half-open socket fails fast instead of mid-scan.
    await this.graph.query('RETURN 1');
    this.connected = true;
  }

  private async exec(stmt: CypherStatement): Promise<void> {
    this.statements.push(stmt);
    if (this.graph) {
      await this.graph.query(stmt.cypher, { params: stmt.params });
    }
  }

  async upsertNode(node: GraphNode): Promise<void> {
    const stmt: CypherStatement = {
      cypher: NODE_WRITE.replace('__LABEL__', node.label),
      params: { id: node.id, props: { ...node.props, id: node.id, label: node.label } },
    };
    await this.exec(stmt);
    this.nodeCounts.set(node.label, (this.nodeCounts.get(node.label) ?? 0) + 1);
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    const stmt: CypherStatement = {
      cypher: EDGE_WRITE.replace('__TYPE__', edge.type),
      params: { from: edge.from, to: edge.to, props: edge.props ?? {} },
    };
    await this.exec(stmt);
    this.edgeCounts.set(edge.type, (this.edgeCounts.get(edge.type) ?? 0) + 1);
  }

  async getNode(_id: string): Promise<GraphNode | undefined> {
    // Read-back queries arrive on Day 2 with the agent tools.
    throw new Error('CypherGraphStore.getNode is not implemented until live reads are wired (Day 2)');
  }

  async neighbors(_id: string, _opts?: NeighborsOptions): Promise<GraphNode[]> {
    throw new Error('CypherGraphStore.neighbors is not implemented until live reads are wired (Day 2)');
  }

  /** Stats derived from generated statements — works with or without a live server. */
  async stats(): Promise<GraphStats> {
    const s = emptyStats();
    s.files = this.nodeCounts.get('File') ?? 0;
    s.functions = this.nodeCounts.get('Function') ?? 0;
    s.classes = this.nodeCounts.get('Class') ?? 0;
    s.imports = this.nodeCounts.get('Import') ?? 0;
    s.commits = this.nodeCounts.get('Commit') ?? 0;
    s.authors = this.nodeCounts.get('Author') ?? 0;
    s.callsEdges = this.edgeCounts.get('CALLS') ?? 0;
    s.importsEdges = this.edgeCounts.get('IMPORTS') ?? 0;
    s.definesEdges = this.edgeCounts.get('DEFINES') ?? 0;
    s.touchedEdges = this.edgeCounts.get('TOUCHED') ?? 0;
    s.ownsEdges = this.edgeCounts.get('OWNS') ?? 0;
    s.authoredEdges = this.edgeCounts.get('AUTHORED') ?? 0;
    return s;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.graph = null;
      this.connected = false;
    }
  }
}
