// Agent loop tests: runScan end-to-end on the vuln-demo fixture —
// scan -> detect -> rank, plus cross-run memory (status carry-over).
// Run: node node_modules/vitest/vitest.mjs run test/loop.test.ts

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runScan } from '../src/agent/loop.js';
import { loadSnapshot, writeSnapshot } from '../src/graph/snapshot.js';
import type { GraphSnapshot } from '../src/graph/types.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/vuln-demo', import.meta.url));

let tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastradius-loop-'));
  tmpDirs.push(dir);
  await fs.cp(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

describe('runScan agent loop', () => {
  it('scans, detects and ranks findings on the vuln fixture', async () => {
    const dir = await copyFixture();
    const report = await runScan(dir, { forceMemory: true, print: false, onLog: () => {} });

    expect(report.findings.length).toBeGreaterThanOrEqual(9);
    const ruleIds = new Set(report.findings.map((f) => String(f.finding.props['ruleId'])));
    for (const id of [
      'hardcoded-secret',
      'sql-concat',
      'dangerous-eval',
      'shell-exec',
      'insecure-random',
      'unsafe-innerhtml',
      'weak-hash',
      'todo-security',
    ]) {
      expect(ruleIds.has(id), `missing rule ${id}`).toBe(true);
    }
    // Ranked highest-impact first: a high-severity finding leads, low trails.
    const severities = report.findings.map((f) => String(f.finding.props['severity']));
    expect(severities[0]).toBe('high');
    expect(severities[severities.length - 1]).toBe('low');

    // Snapshot persisted for the API, with findings + memory nodes.
    const snap = await loadSnapshot(report.repo);
    expect(snap).not.toBeNull();
    expect(snap!.nodes.some((n) => n.label === 'Finding')).toBe(true);
    expect(snap!.nodes.some((n) => n.label === 'Session')).toBe(true);
    expect(snap!.nodes.some((n) => n.label === 'Note')).toBe(true);
    expect(snap!.edges.some((e) => e.type === 'FLAGGED_IN')).toBe(true);
  }, 120000);

  it('carries fixed statuses and notes across runs', async () => {
    const dir = await copyFixture();
    const first = await runScan(dir, { forceMemory: true, print: false, onLog: () => {} });
    const snap = (await loadSnapshot(first.repo)) as GraphSnapshot;

    // Simulate a previous mark_fixed by flipping one finding in the snapshot.
    const target = snap.nodes.find(
      (n) => n.label === 'Finding' && n.props['ruleId'] === 'todo-security',
    );
    expect(target).toBeDefined();
    target!.props['status'] = 'fixed';
    await writeSnapshot(snap);

    const second = await runScan(dir, { forceMemory: true, print: false, onLog: () => {} });

    // The fixed finding drops out of the open ranking...
    const stillOpen = second.findings.map((f) => f.finding.id);
    expect(stillOpen).not.toContain(target!.id);
    // ...but remains in the graph with carried status.
    const snap2 = (await loadSnapshot(second.repo)) as GraphSnapshot;
    const carried = snap2.nodes.find((n) => n.id === target!.id);
    expect(carried?.props['status']).toBe('fixed');
    expect(carried?.props['carriedFixed']).toBe(true);
    // Notes accumulate across runs (one summary note per scan).
    const notes = snap2.nodes.filter((n) => n.label === 'Note');
    expect(notes.length).toBeGreaterThanOrEqual(2);
  }, 120000);
});
