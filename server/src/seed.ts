// Demo snapshot seeding (Day 3 fix).
//
// The deployed server runs on Render's ephemeral filesystem with the
// in-memory store, so scan snapshots vanish on every redeploy/restart.
// The UI auto-loads the pre-scanned "vuln-demo" repo on first paint —
// without a snapshot it just 404s and the demo looks broken.
//
// Fix: bundle a pre-built vuln-demo snapshot in the repo
// (server/demo/vuln-demo.snapshot.json) and install it into the scan cache
// at boot when no snapshot exists yet. Idempotent and non-fatal.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, writeSnapshot } from './graph/snapshot.js';
import type { GraphSnapshot } from './graph/types.js';

export const DEMO_REPO = 'vuln-demo';

/** server/ root — works from both src/ (tsx dev) and dist/ (production). */
export function serverRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function bundledDemoPath(): string {
  return path.join(serverRoot(), 'demo', `${DEMO_REPO}.snapshot.json`);
}

export type SeedResult = 'seeded' | 'already-present' | 'skipped';

interface SeedDeps {
  load: (repo: string) => Promise<GraphSnapshot | null>;
  write: (snapshot: GraphSnapshot) => Promise<string>;
  bundledPath: string;
}

/**
 * Install the bundled demo snapshot into the scan cache when missing.
 * Never throws — a failed seed must not take down server boot.
 */
export async function seedDemoSnapshot(
  deps: SeedDeps = { load: loadSnapshot, write: writeSnapshot, bundledPath: bundledDemoPath() },
): Promise<SeedResult> {
  try {
    const existing = await deps.load(DEMO_REPO);
    if (existing) return 'already-present';
    const raw = await fs.readFile(deps.bundledPath, 'utf8');
    const snapshot = JSON.parse(raw) as GraphSnapshot;
    if (!snapshot || snapshot.repo !== DEMO_REPO || !Array.isArray(snapshot.nodes)) {
      return 'skipped';
    }
    await deps.write(snapshot);
    return 'seeded';
  } catch {
    return 'skipped';
  }
}
