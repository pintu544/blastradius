// BlastRadius scan CLI (Day 1).
//
// Usage:
//   npm run scan -- <repo-url-or-local-path> [--memory]
//
// Clones the repo (if a URL) into a temp dir, parses JS/TS with tree-sitter,
// ingests git history, writes the graph, and prints stats. Exits non-zero
// with a clear message on failure.
//
// Store selection: when FALKORDB_URL is set (via server/.env or the
// environment) the scanner attempts a live FalkorDB connection. A failed
// connection is NON-fatal: it logs "live FalkorDB unreachable from this
// environment; using in-memory store" and falls back. Pass --memory to
// force the in-memory store.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { scanRepo } from './ingest/scanner.js';
import type { GraphStats } from './graph/types.js';

// Load server/.env (gitignored) so FALKORDB_URL works without exporting it.
dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
});

function usage(): void {
  console.log(`BlastRadius scanner — build a code graph from a JS/TS repo.

Usage:
  npm run scan -- <repo-url-or-local-path> [--memory]

Examples:
  npm run scan -- https://github.com/pintu544/blastradius
  npm run scan -- ./my-local-repo --memory

Environment:
  FALKORDB_URL   redis:// URL of FalkorDB, read from server/.env (gitignored)
                 or the environment. When set, the scanner attempts a live
                 connection (one graph per repo); a failed connection is
                 NON-fatal — it warns and falls back to in-memory. Unset or
                 --memory = in-memory.
`);
}

function printStats(stats: GraphStats): void {
  const rows: [string, number][] = [
    ['Files parsed', stats.files],
    ['Functions found', stats.functions],
    ['Classes found', stats.classes],
    ['Import statements', stats.imports],
    ['CALLS edges', stats.callsEdges],
    ['IMPORTS edges', stats.importsEdges],
    ['DEFINES edges', stats.definesEdges],
    ['Commits', stats.commits],
    ['Authors', stats.authors],
    ['TOUCHED edges', stats.touchedEdges],
    ['OWNS edges', stats.ownsEdges],
    ['AUTHORED edges', stats.authoredEdges],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log('');
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }
  const target = args[0];
  const forceMemory = args.includes('--memory');

  const started = Date.now();
  try {
    const result = await scanRepo(target, {
      live: !forceMemory,
      onLog: (msg) => console.log(`[scan] ${msg}`),
    });
    console.log(`[scan] done in ${((Date.now() - started) / 1000).toFixed(1)}s — store: ${result.storeKind}`);
    if (result.fallbackWarning) {
      console.log(`[scan] WARNING: ${result.fallbackWarning}`);
    }
    console.log(`Graph stats for "${result.repo}":`);
    printStats(result.stats);
    console.log(`Snapshot: ${result.snapshotPath}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
