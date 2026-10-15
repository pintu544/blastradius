// End-to-end scan test on the fixture repo (with real git history).
// Copies test/fixtures/sample-repo to a temp dir, creates 3 commits by 2
// authors, runs scanRepo, and asserts the full graph stats.
// Run: npx vitest run test/scan.test.ts

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGraphStore } from '../src/graph/memory.js';
import { scanRepo } from '../src/ingest/scanner.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/sample-repo', import.meta.url));

let tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? 'Alice',
      GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? 'alice@example.com',
      GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME ?? 'Alice',
      GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL ?? 'alice@example.com',
    },
    stdio: 'pipe',
  });
}

async function makeRepoWithHistory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastradius-e2e-'));
  tmpDirs.push(dir);
  await fs.cp(FIXTURE_DIR, dir, { recursive: true });
  git(dir, ['init']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'initial commit']);
  // Bob touches math.js twice -> OWNS(math.js) = Bob.
  await fs.appendFile(path.join(dir, 'src', 'math.js'), '\n// bob was here\n');
  git(dir, ['add', '-A']);
  git(
    dir,
    ['commit', '-m', 'bob tweak 1'],
    { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'bob@example.com' },
  );
  await fs.appendFile(path.join(dir, 'src', 'math.js'), '\n// bob again\n');
  git(dir, ['add', '-A']);
  git(
    dir,
    ['commit', '-m', 'bob tweak 2'],
    { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'bob@example.com' },
  );
  return dir;
}

describe('scanRepo end-to-end', () => {
  it('builds the full graph: files, functions, calls, imports, history', async () => {
    const dir = await makeRepoWithHistory();
    const store = new InMemoryGraphStore();
    const result = await scanRepo(dir, { store, live: false, onLog: () => {} });

    expect(result.repo).toBeTruthy();
    expect(result.storeKind).toBe('memory');
    expect(existsSync(result.snapshotPath)).toBe(true);

    const s = result.stats;
    expect(s.files).toBe(3);
    expect(s.functions).toBe(9); // index: <module>+main; math: add,sub,internal,doubled; app: render,helper,cleanup
    expect(s.classes).toBe(1);
    expect(s.imports).toBe(2);
    expect(s.callsEdges).toBe(5); // module->add, module->main, main->App.render, doubled->internal, helper->cleanup
    expect(s.importsEdges).toBe(2);
    expect(s.definesEdges).toBe(10);
    expect(s.commits).toBe(3);
    expect(s.authors).toBe(2);
    expect(s.touchedEdges).toBe(5);
    expect(s.ownsEdges).toBe(3);
    expect(s.authoredEdges).toBe(3);

    // Snapshot is valid JSON with nodes + edges for the API.
    const snapshot = JSON.parse(await fs.readFile(result.snapshotPath, 'utf8')) as {
      stats: typeof s;
      nodes: unknown[];
      edges: unknown[];
    };
    expect(snapshot.stats.files).toBe(3);
    expect(snapshot.nodes.length).toBeGreaterThan(10);
    expect(snapshot.edges.length).toBeGreaterThan(10);
  });

  it('fails clearly on a missing path', async () => {
    await expect(scanRepo('/does/not/exist', { live: false })).rejects.toThrow(
      'Path does not exist',
    );
  });

  it('scans a non-git directory without history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blastradius-nogit-'));
    tmpDirs.push(dir);
    await fs.cp(FIXTURE_DIR, dir, { recursive: true });
    const result = await scanRepo(dir, { live: false, onLog: () => {} });
    expect(result.stats.files).toBe(3);
    expect(result.stats.commits).toBe(0);
    expect(result.stats.authors).toBe(0);
  });
});
