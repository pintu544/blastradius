// GraphStore factory — picks the backend for a scan.
//
// Default: InMemoryGraphStore (local dev, tests).
// When FALKORDB_URL is set (and `live` isn't disabled): attempt a live
// CypherGraphStore connection. Connection failures are NON-fatal: log a
// clear warning and fall back to in-memory so a scan never dies just because
// the database is unreachable from this environment.

import { CypherGraphStore } from './cypher.js';
import { InMemoryGraphStore } from './memory.js';
import type { GraphStore } from './store.js';

export interface StoreChoice {
  store: GraphStore;
  kind: 'memory' | 'cypher';
  /** Non-null when a live connection was attempted but failed. */
  fallbackWarning: string | null;
}

export async function createGraphStore(
  repoName: string,
  opts: { live?: boolean; onLog?: (msg: string) => void } = {},
): Promise<StoreChoice> {
  const url = process.env.FALKORDB_URL;
  if (opts.live === false || !url) {
    return { store: new InMemoryGraphStore(), kind: 'memory', fallbackWarning: null };
  }
  const cypher = new CypherGraphStore(repoName, url);
  try {
    await cypher.connect();
    opts.onLog?.(`Connected to FalkorDB (${cypher.graphName}) — writing live.`);
    return { store: cypher, kind: 'cypher', fallbackWarning: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Deliberately NOT echoing the URL: it may contain credentials.
    const warning =
      `live FalkorDB unreachable from this environment (${reason}); using in-memory store`;
    opts.onLog?.(`WARNING: ${warning}`);
    return { store: new InMemoryGraphStore(), kind: 'memory', fallbackWarning: warning };
  }
}
