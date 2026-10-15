// Snapshot helpers: the server/.scan-cache/<repo>.json round-trip shared by
// the scanner (writer), the agent loop and the API (readers). Lets findings
// keep their status across runs and lets the API serve a graph without
// re-scanning.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryGraphStore } from './memory.js';
import type { GraphSnapshot } from './types.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_CACHE_DIR = path.join(SERVER_ROOT, '.scan-cache');

export function snapshotPathFor(repo: string): string {
  return path.join(SCAN_CACHE_DIR, `${repo}.json`);
}

export async function writeSnapshot(snapshot: GraphSnapshot): Promise<string> {
  await fs.mkdir(SCAN_CACHE_DIR, { recursive: true });
  const p = snapshotPathFor(snapshot.repo);
  await fs.writeFile(p, JSON.stringify(snapshot));
  return p;
}

/** null when no previous scan exists (first run) or the file is corrupt. */
export async function loadSnapshot(repo: string): Promise<GraphSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPathFor(repo), 'utf8');
    const snap = JSON.parse(raw) as GraphSnapshot;
    if (!snap || !Array.isArray(snap.nodes) || !Array.isArray(snap.edges)) return null;
    return snap;
  } catch {
    return null;
  }
}

/**
 * Rebuild an in-memory store from a snapshot (nodes first, then edges —
 * InMemoryGraphStore drops edges whose endpoints are missing, so order
 * matters).
 */
export async function hydrateStore(snapshot: GraphSnapshot): Promise<InMemoryGraphStore> {
  const store = new InMemoryGraphStore();
  for (const n of snapshot.nodes) await store.upsertNode(n);
  for (const e of snapshot.edges) await store.addEdge(e);
  return store;
}
