// Deterministic agent loop (Day 2): scan -> detect -> rank -> report.
//
// No LLM here — this orchestrator runs the same agent tools (agent/tools.ts)
// the future LLM agent will call, prints a ranked findings table, and returns
// a machine-readable report. Fully testable without network: pass
// forceMemory and a local path.

import * as path from 'node:path';
import { hydrateStore, loadSnapshot } from '../graph/snapshot.js';
import type { GraphStats } from '../graph/types.js';
import { sanitizeRepoName, scanRepo } from '../ingest/scanner.js';
import { impact_rank, type RankedFinding } from './tools.js';

export interface LoopOptions {
  /** Attempt a live FalkorDB connection when FALKORDB_URL is set. */
  live?: boolean;
  /** Force the in-memory store (overrides live). */
  forceMemory?: boolean;
  onLog?: (msg: string) => void;
  /** Print the stats + findings table (default true). */
  print?: boolean;
}

export interface AgentReport {
  repo: string;
  scannedAt: string;
  stats: GraphStats;
  /** Open findings, ranked by impact (highest first). */
  findings: RankedFinding[];
  storeKind: 'memory' | 'cypher';
  snapshotPath: string;
  fallbackWarning: string | null;
}

export function printStats(stats: GraphStats): void {
  const rows: [string, number][] = [
    ['Files parsed', stats.files],
    ['Functions found', stats.functions],
    ['Classes found', stats.classes],
    ['Import statements', stats.imports],
    ['CALLS edges', stats.callsEdges],
    ['IMPORTS edges', stats.importsEdges],
    ['DEFINES edges', stats.definesEdges],
    ['Findings', stats.findings],
    ['REACHES edges', stats.reachesEdges],
    ['Commits', stats.commits],
    ['Authors', stats.authors],
    ['TOUCHED edges', stats.touchedEdges],
    ['OWNS edges', stats.ownsEdges],
    ['Notes / Sessions', stats.notes + stats.sessions],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log('');
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
  console.log('');
}

export function printFindingsTable(repo: string, findings: RankedFinding[]): void {
  console.log(`Ranked findings for "${repo}" — ${findings.length} open:`);
  if (findings.length === 0) {
    console.log('  (no open findings — clean scan)');
    console.log('');
    return;
  }
  const header = ['#', 'SEV', 'SCORE', 'BLAST', 'RULE', 'LOCATION', 'TITLE'];
  const rows = findings.map((f, i) => {
    const p = f.finding.props;
    return [
      String(i + 1),
      String(p['severity']).toUpperCase(),
      f.score.toFixed(2),
      String(f.blastSize),
      String(p['ruleId']),
      `${p['file']}:${p['line']}`,
      String(p['title']),
    ];
  });
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => r[c].length)),
  );
  const fmt = (cells: string[]): string =>
    '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(r));
  console.log('');
}

export async function runScan(target: string, opts: LoopOptions = {}): Promise<AgentReport> {
  const log = opts.onLog ?? (() => {});
  const repo = sanitizeRepoName(path.basename(target));

  const previous = await loadSnapshot(repo);
  if (previous) {
    log(
      `Loaded previous snapshot (${previous.nodes.length} nodes, scanned ${previous.scannedAt}) — ` +
        'carrying finding statuses and notes.',
    );
  }

  const result = await scanRepo(target, {
    live: opts.forceMemory ? false : (opts.live ?? true),
    analyze: true,
    previousSnapshot: previous,
    onLog: log,
  });

  // Re-hydrate from the snapshot: the single source of truth the API serves.
  const snapshot = await loadSnapshot(repo);
  if (!snapshot) {
    throw new Error('scan completed but no snapshot was written — cannot rank findings');
  }
  const store = await hydrateStore(snapshot);
  const findings = await impact_rank(store);

  if (opts.print !== false) {
    console.log(`Graph stats for "${repo}":`);
    printStats(result.stats);
    printFindingsTable(repo, findings);
    console.log(`Snapshot: ${result.snapshotPath}`);
  }

  return {
    repo,
    scannedAt: snapshot.scannedAt,
    stats: result.stats,
    findings,
    storeKind: result.storeKind,
    snapshotPath: result.snapshotPath,
    fallbackWarning: result.fallbackWarning,
  };
}
