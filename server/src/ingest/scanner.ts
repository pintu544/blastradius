// Scanner orchestration: clone (if URL) -> enumerate files -> tree-sitter
// parse -> resolve CALLS -> git history -> write nodes/edges -> snapshot.
//
// One graph per repo (FalkorDB multigraph when live; one in-memory store per
// scan otherwise). After every scan a JSON snapshot is written to
// server/.scan-cache/<repo>.json so the API can serve stats without
// re-scanning (see GET /api/stats in src/index.ts).

import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createGraphStore } from '../graph/factory.js';
import { writeSnapshot } from '../graph/snapshot.js';
import type { GraphStore } from '../graph/store.js';
import {
  emptyStats,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type GraphStats,
} from '../graph/types.js';
import { analyzeGraph } from '../detect/analyze.js';
import { authorNodeId, commitNodeId, deriveOwners, readGitHistory } from './git.js';
import { languageForExtension, parseSource, type ParsedFile } from './parser.js';
import {
  classNodeId,
  fileNodeId,
  functionNodeId,
  importNodeId,
  resolveCalls,
} from './resolve.js';

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor',
]);

export interface ScanOptions {
  /** Inject a store (tests). Otherwise chosen via createGraphStore. */
  store?: GraphStore;
  /** Attempt a live FalkorDB connection when FALKORDB_URL is set (default true). */
  live?: boolean;
  /** Run Day 2 detection + memory analysis after ingestion (default false). */
  analyze?: boolean;
  /** Previous snapshot for carrying finding statuses / notes across runs. */
  previousSnapshot?: GraphSnapshot | null;
  maxCommits?: number;
  onLog?: (msg: string) => void;
}

export interface ScanResult {
  repo: string;
  stats: GraphStats;
  snapshotPath: string;
  storeKind: 'memory' | 'cypher';
  fallbackWarning: string | null;
}

const URL_RE = /^(https?:\/\/|git@|ssh:\/\/)/;

export function sanitizeRepoName(name: string): string {
  return (
    name
      .replace(/\.git$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'repo'
  );
}

async function listCodeFiles(dir: string, onLog?: (msg: string) => void): Promise<string[]> {
  // Prefer `git ls-files` inside repos: honors .gitignore for free.
  if (existsSync(path.join(dir, '.git'))) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'ls-files', '-z']);
      return stdout
        .split('\0')
        .filter((f) => f !== '' && languageForExtension(path.extname(f)) !== null)
        .map((f) => path.join(dir, f.split('/').join(path.sep)));
    } catch {
      onLog?.('git ls-files failed; falling back to directory walk.');
    }
  }
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && languageForExtension(path.extname(e.name)) !== null) {
        out.push(full);
      }
    }
  };
  await walk(dir);
  return out;
}

export async function scanRepo(target: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const log = opts.onLog ?? (() => {});
  let workDir: string;
  let cleanup: (() => Promise<void>) | null = null;

  if (URL_RE.test(target) || target.endsWith('.git')) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'blastradius-'));
    log(`Cloning ${target} ...`);
    try {
      await execFileAsync('git', ['clone', '--depth', '1', target, tmp]);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw new Error(
        `Failed to clone ${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    workDir = tmp;
    cleanup = () => fs.rm(tmp, { recursive: true, force: true });
  } else {
    workDir = path.resolve(target);
    if (!existsSync(workDir)) {
      throw new Error(`Path does not exist: ${target}`);
    }
    const stat = await fs.stat(workDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${target}`);
    }
  }

  try {
    const repo = sanitizeRepoName(path.basename(target));
    log(`Scanning ${repo} ...`);

    const { store, kind, fallbackWarning } = opts.store
      ? { store: opts.store, kind: opts.store.kind, fallbackWarning: null }
      : await createGraphStore(repo, { live: opts.live, onLog: log });

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const stats = emptyStats();

    const putNode = async (node: GraphNode): Promise<void> => {
      await store.upsertNode(node);
      nodes.push(node);
    };
    const putEdge = async (edge: GraphEdge): Promise<void> => {
      await store.addEdge(edge);
      edges.push(edge);
    };

    // --- 1. Parse files ---------------------------------------------------
    const absFiles = await listCodeFiles(workDir, log);
    const parsed: ParsedFile[] = [];
    const sources = new Map<string, string>();
    for (const abs of absFiles) {
      const rel = path.relative(workDir, abs).split(path.sep).join(path.posix.sep);
      let source: string;
      try {
        source = await fs.readFile(abs, 'utf8');
      } catch {
        continue; // unreadable — skip, don't die
      }
      if (source.includes('\0')) continue; // binary
      const lang = languageForExtension(path.extname(abs));
      if (!lang) continue;
      try {
        const pf = await parseSource(source, rel, lang);
        parsed.push(pf);
        sources.set(rel, source);
      } catch (err) {
        log(`  parse warning: ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`Parsed ${parsed.length} files.`);

    for (const pf of parsed) {
      const fid = fileNodeId(pf.path);
      await putNode({
        id: fid,
        label: 'File',
        props: { path: pf.path, language: pf.language, loc: pf.loc },
      });
      for (const fn of pf.functions) {
        const fnId = functionNodeId(pf.path, fn);
        await putNode({
          id: fnId,
          label: 'Function',
          props: {
            name: fn.name,
            qualifiedName: fn.qualifiedName,
            file: pf.path,
            startLine: fn.startLine,
            endLine: fn.endLine,
            exported: fn.exported,
            kind: fn.kind,
          },
        });
        await putEdge({ from: fid, to: fnId, type: 'DEFINES' });
      }
      for (const cls of pf.classes) {
        const cid = classNodeId(pf.path, cls.name);
        await putNode({
          id: cid,
          label: 'Class',
          props: { name: cls.name, qualifiedName: cls.name, file: pf.path },
        });
        await putEdge({ from: fid, to: cid, type: 'DEFINES' });
      }
      for (const imp of pf.imports) {
        const iid = importNodeId(pf.path, imp);
        await putNode({
          id: iid,
          label: 'Import',
          props: {
            module: imp.module,
            importedNames: [...imp.names, ...(imp.defaultName ? [imp.defaultName] : [])],
            file: pf.path,
          },
        });
        await putEdge({ from: fid, to: iid, type: 'IMPORTS' });
      }
    }

    // --- 2. Resolve CALLS --------------------------------------------------
    for (const edge of resolveCalls(parsed)) {
      await putEdge(edge);
    }

    // --- 3. Git history ----------------------------------------------------
    const history = await readGitHistory(workDir, opts.maxCommits ?? 1000);
    if (history) {
      log(`Ingesting ${history.commits.length} commits ...`);
      const seenAuthors = new Set<string>();
      const fileIds = new Set(parsed.map((p) => fileNodeId(p.path)));
      for (const commit of history.commits) {
        const cid = commitNodeId(commit.sha);
        await putNode({
          id: cid,
          label: 'Commit',
          props: {
            sha: commit.sha,
            message: commit.message.slice(0, 500),
            timestamp: commit.timestamp,
          },
        });
        if (commit.authorEmail && !seenAuthors.has(commit.authorEmail.toLowerCase())) {
          seenAuthors.add(commit.authorEmail.toLowerCase());
          await putNode({
            id: authorNodeId(commit.authorEmail),
            label: 'Author',
            props: { name: commit.authorName, email: commit.authorEmail },
          });
        }
        if (commit.authorEmail) {
          await putEdge({ from: authorNodeId(commit.authorEmail), to: cid, type: 'AUTHORED' });
        }
        for (const f of commit.files) {
          const fid = fileNodeId(f);
          if (fileIds.has(fid)) {
            await putEdge({ from: cid, to: fid, type: 'TOUCHED' });
          }
        }
      }
      for (const owner of deriveOwners(history)) {
        const fid = fileNodeId(owner.file);
        if (fileIds.has(fid)) {
          await putEdge({
            from: authorNodeId(owner.email),
            to: fid,
            type: 'OWNS',
            props: { touches: owner.touches },
          });
        }
      }
    } else {
      log('No git history found (not a repo or git unavailable) — skipping commits/authors.');
    }

    const finalStats = await store.stats();
    Object.assign(stats, finalStats);

    // --- 4. Detection + memory (Day 2) -------------------------------------
    if (opts.analyze) {
      log('Running detection rules ...');
      await analyzeGraph(
        parsed,
        sources,
        { store, putNode, putEdge, onLog: log },
        { repo, previous: opts.previousSnapshot ?? null },
      );
      Object.assign(stats, await store.stats());
    }

    // --- 5. Snapshot for the API ------------------------------------------
    const snapshot: GraphSnapshot = {
      repo,
      scannedAt: new Date().toISOString(),
      stats,
      nodes,
      edges,
    };
    const snapshotPath = await writeSnapshot(snapshot);
    log(`Snapshot written to ${snapshotPath}`);

    await store.close();
    return { repo, stats, snapshotPath, storeKind: kind, fallbackWarning };
  } finally {
    if (cleanup) await cleanup();
  }
}
