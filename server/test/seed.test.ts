// Tests for demo snapshot seeding (Day 3 fix).

import { describe, expect, it } from 'vitest';
import { DEMO_REPO, seedDemoSnapshot } from '../src/seed.js';
import type { GraphSnapshot } from '../src/graph/types.js';

const fakeSnapshot = (repo: string): GraphSnapshot =>
  ({
    repo,
    scannedAt: '2026-10-15T00:00:00.000Z',
    stats: {},
    nodes: [{ id: 'n1', label: 'File', props: {} }],
    edges: [],
  }) as unknown as GraphSnapshot;

describe('seedDemoSnapshot', () => {
  it('is a no-op when a snapshot already exists', async () => {
    let writes = 0;
    const result = await seedDemoSnapshot({
      load: async () => fakeSnapshot(DEMO_REPO),
      write: async () => {
        writes += 1;
        return '/tmp/x';
      },
      bundledPath: '/nonexistent/path.json',
    });
    expect(result).toBe('already-present');
    expect(writes).toBe(0);
  });

  it('seeds from the bundled file when the cache is empty', async () => {
    let written: GraphSnapshot | null = null;
    const result = await seedDemoSnapshot({
      load: async () => null,
      write: async (s) => {
        written = s;
        return '/tmp/x';
      },
      // reuse the real bundled snapshot as the source
      bundledPath: new URL('../demo/vuln-demo.snapshot.json', import.meta.url).pathname,
    });
    expect(result).toBe('seeded');
    expect(written).not.toBeNull();
    expect((written as unknown as GraphSnapshot).repo).toBe(DEMO_REPO);
    expect((written as unknown as GraphSnapshot).nodes.length).toBeGreaterThan(0);
  });

  it('skips (never throws) when the bundled file is missing', async () => {
    let writes = 0;
    const result = await seedDemoSnapshot({
      load: async () => null,
      write: async () => {
        writes += 1;
        return '/tmp/x';
      },
      bundledPath: '/nonexistent/vuln-demo.snapshot.json',
    });
    expect(result).toBe('skipped');
    expect(writes).toBe(0);
  });

  it('skips when the bundled file has the wrong repo name', async () => {
    let writes = 0;
    const result = await seedDemoSnapshot({
      load: async () => null,
      write: async () => {
        writes += 1;
        return '/tmp/x';
      },
      bundledPath: new URL('./seed.test.ts', import.meta.url).pathname, // valid file, wrong shape
    });
    expect(result).toBe('skipped');
    expect(writes).toBe(0);
  });
});
