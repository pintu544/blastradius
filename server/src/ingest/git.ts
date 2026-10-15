// Git history ingestion: Commit / Author nodes, AUTHORED / TOUCHED edges,
// and derived OWNS edges (author -> file with the most touches wins).
//
// Only runs when the scanned directory is a git repo and the `git` binary is
// available; otherwise the scan continues without history and logs a warning.
// History is capped at `maxCommits` (default 1000) so huge repos stay fast.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitCommit {
  sha: string;
  message: string;
  /** Unix epoch seconds. */
  timestamp: number;
  authorName: string;
  authorEmail: string;
  /** Repo-relative file paths touched by this commit (JS/TS only). */
  files: string[];
}

export interface GitHistory {
  commits: GitCommit[];
}

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
]);

function isCodeFile(p: string): boolean {
  return CODE_EXTENSIONS.has(path.posix.extname(p).toLowerCase());
}

/**
 * Read commit history for `dir`. Returns null when `dir` is not a git repo
 * or git is unavailable — callers must treat that as "no history", not an error.
 */
export async function readGitHistory(dir: string, maxCommits = 1000): Promise<GitHistory | null> {
  if (!existsSync(path.join(dir, '.git'))) return null;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      [
        '-C', dir,
        'log',
        `--max-count=${maxCommits}`,
        '--format=COMMIT%x1f%H%x1f%an%x1f%ae%x1f%at%x1f%s',
        '--name-only',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return null; // git missing, repo corrupt, etc. — history is optional.
  }

  const commits: GitCommit[] = [];
  let current: GitCommit | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('COMMIT\x1f')) {
      const [, sha, authorName, authorEmail, ts, message] = line.split('\x1f');
      current = {
        sha,
        message: (message ?? '').trim(),
        timestamp: Number(ts) || 0,
        authorName: (authorName ?? '').trim(),
        authorEmail: (authorEmail ?? '').trim(),
        files: [],
      };
      commits.push(current);
    } else if (current && line.trim() !== '') {
      const f = line.trim();
      if (isCodeFile(f) && !current.files.includes(f)) current.files.push(f);
    }
  }
  return { commits };
}

/** author email -> file path -> touch count */
export function countTouches(history: GitHistory): Map<string, Map<string, number>> {
  const touches = new Map<string, Map<string, number>>();
  for (const commit of history.commits) {
    if (!commit.authorEmail) continue;
    let perFile = touches.get(commit.authorEmail);
    if (!perFile) {
      perFile = new Map();
      touches.set(commit.authorEmail, perFile);
    }
    for (const f of commit.files) {
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
    }
  }
  return touches;
}

/**
 * Derive ownership: for each file, the author with the most touches wins.
 * Ties go to the earliest committer among the tied authors (deterministic).
 */
export function deriveOwners(history: GitHistory): { email: string; file: string; touches: number }[] {
  const touches = countTouches(history);
  const firstSeen = new Map<string, Map<string, number>>(); // email -> file -> commit index
  history.commits.forEach((commit, idx) => {
    if (!commit.authorEmail) return;
    let perFile = firstSeen.get(commit.authorEmail);
    if (!perFile) {
      perFile = new Map();
      firstSeen.set(commit.authorEmail, perFile);
    }
    for (const f of commit.files) {
      if (!perFile.has(f)) perFile.set(f, idx);
    }
  });

  const files = new Set<string>();
  for (const perFile of touches.values()) {
    for (const f of perFile.keys()) files.add(f);
  }

  const owners: { email: string; file: string; touches: number }[] = [];
  for (const f of files) {
    let best: { email: string; touches: number; firstSeen: number } | null = null;
    for (const [email, perFile] of touches) {
      const t = perFile.get(f) ?? 0;
      if (t === 0) continue;
      const seen = firstSeen.get(email)?.get(f) ?? Number.MAX_SAFE_INTEGER;
      if (!best || t > best.touches || (t === best.touches && seen < best.firstSeen)) {
        best = { email, touches: t, firstSeen: seen };
      }
    }
    if (best) owners.push({ email: best.email, file: f, touches: best.touches });
  }
  return owners;
}

export const commitNodeId = (sha: string): string => `commit:${sha}`;
export const authorNodeId = (email: string): string => `author:${email.toLowerCase()}`;
