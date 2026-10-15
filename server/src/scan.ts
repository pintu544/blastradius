// BlastRadius scan CLI (Day 2).
//
// Usage:
//   npm run scan -- <repo-url-or-local-path> [--memory]
//
// Runs the deterministic agent loop: scan -> detect -> rank -> report.
// Prints graph stats plus the ranked findings table. Exits non-zero with a
// clear message on failure.
//
// Store selection: when FALKORDB_URL is set (via server/.env or the
// environment) the scanner attempts a live FalkorDB connection. A failed
// connection is NON-fatal: it logs a warning and falls back to in-memory.
// Pass --memory to force the in-memory store.

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { runScan } from './agent/loop.js';

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

The run prints graph stats plus a ranked findings table
(severity x blast-radius x centrality).
`);
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
    const report = await runScan(target, {
      forceMemory,
      onLog: (msg) => console.log(`[scan] ${msg}`),
    });
    console.log(`[scan] done in ${((Date.now() - started) / 1000).toFixed(1)}s — store: ${report.storeKind}`);
    if (report.fallbackWarning) {
      console.log(`[scan] WARNING: ${report.fallbackWarning}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
