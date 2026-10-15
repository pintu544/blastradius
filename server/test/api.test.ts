// Endpoint tests for the Day 3 API (supertest against createApp()).
// Covers POST /api/scan, GET /api/ask and the extended /api/findings.
// Run: node node_modules/vitest/vitest.mjs run test/api.test.ts

import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { runScan } from '../src/agent/loop.js';
import { createApp } from '../src/app.js';

const VULN_DEMO_DIR = fileURLToPath(new URL('./fixtures/vuln-demo', import.meta.url));
const SAMPLE_REPO_DIR = fileURLToPath(new URL('./fixtures/sample-repo', import.meta.url));

const app = createApp();

beforeAll(async () => {
  // Guarantee a fresh in-memory snapshot for the read endpoints.
  await runScan(VULN_DEMO_DIR, { print: false, forceMemory: true });
}, 60000);

describe('GET /api/stats', () => {
  it('400 when ?repo is missing', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(400);
  });

  it('404 for an unknown repo', async () => {
    const res = await request(app).get('/api/stats?repo=no-such-repo-xyz');
    expect(res.status).toBe(404);
  });

  it('200 with stats for a scanned repo', async () => {
    const res = await request(app).get('/api/stats?repo=vuln-demo');
    expect(res.status).toBe(200);
    expect(res.body.repo).toBe('vuln-demo');
    expect(res.body.stats.functions).toBeGreaterThan(0);
  });
});

describe('POST /api/scan', () => {
  it('400 on missing or invalid body.repo', async () => {
    for (const body of [{}, { repo: '' }, { repo: 42 }, { repo: 'x'.repeat(501) }]) {
      const res = await request(app).post('/api/scan').send(body);
      expect(res.status).toBe(400);
    }
  });

  it('422 for a nonexistent local path', async () => {
    const res = await request(app)
      .post('/api/scan')
      .send({ repo: '/tmp/blastradius-does-not-exist-xyz', memory: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/does not exist/i);
  });

  it('200 and returns stats + findings for a local fixture', async () => {
    const res = await request(app)
      .post('/api/scan')
      .send({ repo: SAMPLE_REPO_DIR, memory: true });
    expect(res.status).toBe(200);
    expect(res.body.repo).toBe('sample-repo');
    expect(res.body.stats.functions).toBeGreaterThan(0);
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.storeKind).toBe('memory');
  }, 60000);
});

describe('GET /api/findings', () => {
  it('400 when ?repo is missing, 404 for unknown repo', async () => {
    expect((await request(app).get('/api/findings')).status).toBe(400);
    expect((await request(app).get('/api/findings?repo=no-such-repo-xyz')).status).toBe(404);
  });

  it('returns ranked findings with owner field', async () => {
    const res = await request(app).get('/api/findings?repo=vuln-demo');
    expect(res.status).toBe(200);
    expect(res.body.open).toBeGreaterThan(0);
    const findings = res.body.findings as Record<string, unknown>[];
    expect(findings.length).toBe(res.body.open);
    for (const f of findings) {
      expect(typeof f['id']).toBe('string');
      expect(typeof f['severity']).toBe('string');
      expect(typeof f['score']).toBe('number');
      expect('owner' in f).toBe(true); // null when no git history
    }
    const scores = findings.map((f) => f['score'] as number);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });
});

describe('GET /api/blast-radius/:findingId', () => {
  it('404 for an unknown finding id', async () => {
    const res = await request(app).get('/api/blast-radius/bogus-id?repo=vuln-demo');
    expect(res.status).toBe(404);
  });

  it('returns nodes, edges and the Cypher for a real finding', async () => {
    const list = await request(app).get('/api/findings?repo=vuln-demo');
    const id = list.body.findings[0].id as string;
    const res = await request(app).get(
      `/api/blast-radius/${encodeURIComponent(id)}?repo=vuln-demo`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(res.body.cypher).toMatch(/CALLS/);
    expect(res.body.finding.id).toBe(id);
  });
});

describe('GET /api/ask', () => {
  it('400 when ?repo or ?q is missing', async () => {
    expect((await request(app).get('/api/ask?repo=vuln-demo')).status).toBe(400);
    expect((await request(app).get('/api/ask?q=getUser')).status).toBe(400);
  });

  it('404 for an unknown repo', async () => {
    const res = await request(app).get('/api/ask?repo=no-such-repo-xyz&q=getUser');
    expect(res.status).toBe(404);
  });

  it('404 when nothing matches', async () => {
    const res = await request(app).get('/api/ask?repo=vuln-demo&q=zzzznonexistentfn');
    expect(res.status).toBe(404);
  });

  it('traces a named function with summary + cypher', async () => {
    const res = await request(app).get('/api/ask?repo=vuln-demo&q=getUser');
    expect(res.status).toBe(200);
    expect(String(res.body.match.name).toLowerCase()).toContain('getuser');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(res.body.cypher).toMatch(/CALLS/);
    expect(typeof res.body.summary).toBe('string');
    expect(res.body.summary.length).toBeGreaterThan(20);
  });

  it('handles a natural-language question', async () => {
    const res = await request(app).get(
      '/api/ask?repo=vuln-demo&q=' + encodeURIComponent('what breaks if I change login?'),
    );
    expect(res.status).toBe(200);
    expect(String(res.body.match.name).toLowerCase()).toContain('login');
  });
});

describe('CORS', () => {
  it('sends Access-Control-Allow-Origin on API responses', async () => {
    const res = await request(app)
      .get('/api/stats?repo=vuln-demo')
      .set('Origin', 'https://blastradius-eosin.vercel.app');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers preflight OPTIONS requests', async () => {
    const res = await request(app)
      .options('/api/scan')
      .set('Origin', 'https://blastradius-eosin.vercel.app')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
