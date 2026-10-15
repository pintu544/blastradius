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
import type * as net from 'node:net';

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

function parseConnectionUrl(url: string): {
  host: string;
  port: number;
  tls: boolean;
  password: string | null;
} {
  // Accept redis://, falkor:// (FalkorDB Cloud dashboard format — the driver
  // itself documents falkor[s]:// URLs and rewrites them to redis[s]://),
  // and rediss:// / falkors:// (TLS).
  // The URL itself is never echoed in errors: it may contain credentials.
  const m = /^(redis|falkor|rediss|falkors):\/\/(?:([^:@]*)(?::([^@]*))?@)?([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) {
    throw new Error('FALKORDB_URL must be a redis://, falkor://, rediss:// or falkors:// URL');
  }
  const scheme = m[1];
  return {
    host: m[4],
    port: m[5] ? Number(m[5]) : 6379,
    tls: scheme === 'rediss' || scheme === 'falkors',
    password: m[3] ?? null,
  };
}

function rejectAfter<T>(ms: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    // Don't let a stray timer keep the process alive after the race settles.
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Speak just enough RESP to prove the endpoint is a Redis/FalkorDB server:
 * optional AUTH, then PING expecting +PONG. Rejects on timeouts, TCP errors,
 * auth failures, or non-RESP chatter. Fully self-contained (own socket, own
 * handlers) so a hostile endpoint can never crash the process.
 */
async function probeEndpoint(
  host: string,
  port: number,
  tls: boolean,
  password: string | null,
  timeoutMs = 5000,
): Promise<void> {
  const netMod = await import('node:net');
  const tlsMod = tls ? await import('node:tls') : null;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stage: 'auth' | 'ping' = password ? 'auth' : 'ping';
    let buffer = '';
    let socket: net.Socket | null = null;

    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        try {
          socket.removeAllListeners();
          socket.destroy();
        } catch {
          /* ignore */
        }
        socket = null;
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => done(new Error(`endpoint probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    (timer as unknown as { unref?: () => void }).unref?.();

    const writeLine = (line: string): void => {
      try {
        socket?.write(line);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const sendAuthOrPing = (): void => {
      if (password) {
        const p = Buffer.from(password, 'utf8');
        writeLine(`*2\r\n$4\r\nAUTH\r\n$${p.length}\r\n${password}\r\n`);
      } else {
        writeLine('PING\r\n');
      }
    };

    const pump = (): void => {
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (stage === 'auth') {
          if (line.startsWith('+OK')) {
            stage = 'ping';
            writeLine('PING\r\n');
          } else {
            done(new Error(`endpoint rejected AUTH (${line.slice(0, 40)})`));
            return;
          }
        } else if (line.startsWith('+PONG')) {
          done();
          return;
        } else {
          done(new Error('endpoint did not answer a RESP PING (not a Redis/FalkorDB server?)'));
          return;
        }
      }
    };

    try {
      if (tls && tlsMod) {
        const s = tlsMod.connect({ host, port, servername: host, timeout: timeoutMs });
        socket = s;
        s.on('secureConnect', sendAuthOrPing);
      } else {
        const s = netMod.connect(port, host);
        socket = s;
        s.setTimeout(timeoutMs);
        s.on('connect', sendAuthOrPing);
        s.on('timeout', () => done(new Error(`endpoint probe timed out after ${timeoutMs}ms`)));
      }
      socket.on('error', (err: Error) => done(err));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 4096) {
          done(new Error('endpoint sent unexpected data during probe'));
          return;
        }
        pump();
      });
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// Minimal structural typing for the driver pieces we use, so the module
// loads without the driver installed until connect() is actually called.
interface DriverGraph {
  query(cypher: string, options?: { params?: Record<string, unknown> }): Promise<unknown>;
}
interface DriverClient {
  selectGraph(graphId: string): DriverGraph;
  close(): Promise<void>;
  on(event: 'error', listener: (err: unknown) => void): void;
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

  /**
   * Attempt a live connection. Throws when FALKORDB_URL is unset or the
   * endpoint is unreachable — but NEVER crashes the process. Three layers:
   *   1. Probe the endpoint with our own socket first (AUTH/PING). The
   *      driver's FalkorDB.connect() forwards redis 'error' events to the
   *      instance, which becomes an *unhandled 'error' event* (process
   *      crash) when the endpoint speaks garbage and no listener exists
   *      yet. The probe keeps us away from the driver in that case.
   *   2. A scoped uncaughtException guard + timeouts around the driver's
   *      connect, covering the residual window where its error forwarding
   *      could fire before we can attach our listener.
   *   3. An 'error' listener attached synchronously after connect resolves,
   *      so later async failures surface via query() rejections, not crashes.
   */
  async connect(): Promise<void> {
    if (!this.url) throw new Error('FALKORDB_URL is not set — cannot connect to FalkorDB');
    const { host, port, tls, password } = parseConnectionUrl(this.url);

    await probeEndpoint(host, port, tls, password);

    // Dynamic import: the driver is only required when a live connection is attempted.
    const { FalkorDB } = (await import('falkordb')) as {
      FalkorDB: {
        connect(options?: unknown): Promise<DriverClient>;
      };
    };

    let strayError: unknown = null;
    const strayHandler = (err: unknown): void => {
      if (strayError === null) strayError = err;
    };
    process.on('uncaughtException', strayHandler);
    let client: DriverClient;
    try {
      // If the race settles first, the driver's late rejection must not
      // become an unhandled rejection (Node crashes on those by default).
      const attempt = FalkorDB.connect({ url: this.url });
      attempt.catch(() => {});
      client = await Promise.race([attempt, rejectAfter<DriverClient>(12000, 'FalkorDB driver connect timed out')]);
    } finally {
      process.removeListener('uncaughtException', strayHandler);
    }
    if (strayError !== null) {
      throw strayError instanceof Error ? strayError : new Error(String(strayError));
    }

    client.on('error', () => {
      /* swallowed: post-connect failures surface via query()/close() rejections */
    });
    this.client = client;
    this.graph = client.selectGraph(this.graphName);
    // Bounded smoke test so a half-open connection fails fast instead of mid-scan.
    const smoke = this.graph.query('RETURN 1');
    smoke.catch(() => {});
    await Promise.race([smoke, rejectAfter<unknown>(8000, 'FalkorDB smoke query timed out')]);
    this.connected = true;
  }

  /** Quietly release a half-open client after a failed attempt. Never throws. */
  async abort(): Promise<void> {
    if (this.client) {
      try {
        this.client.on('error', () => {});
        await this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
      this.graph = null;
      this.connected = false;
    }
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
