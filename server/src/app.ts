// Express app factory for BlastRadius (Day 3).
//
// index.ts (the process entry) calls createApp().listen(...); tests import
// createApp() and drive it with supertest without opening a port.
//
// Endpoints:
//   GET  /health
//   GET  /api/stats?repo=
//   GET  /api/findings?repo=            (ranked open findings + suggested owner)
//   GET  /api/blast-radius/:findingId?repo=
//   POST /api/scan        { repo: <url-or-local-path>, memory?: boolean }
//   GET  /api/ask?repo=&q=              ("what breaks if I change X?")

import express from 'express';
import cors from 'cors';
import {
  blast_radius,
  impact_rank,
  owner_of,
  reachableFunctions,
} from './agent/tools.js';
import { runScan } from './agent/loop.js';
import { hydrateStore, loadSnapshot } from './graph/snapshot.js';
import type { GraphNode } from './graph/types.js';

const URL_LIKE = /^(https?:\/\/|git@|ssh:\/\/)/;

function validRepoName(repo: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(repo);
}

function validFindingId(id: string): boolean {
  return /^[A-Za-z0-9:_\-./#]+$/.test(id) && id.length <= 200;
}

interface OwnerView {
  name: string;
  email: string;
}

async function suggestedOwner(
  store: Parameters<typeof owner_of>[0],
  flagged: GraphNode | undefined,
): Promise<OwnerView | null> {
  if (!flagged) return null;
  try {
    const o = await owner_of(store, flagged.id);
    return o ? { name: o.name, email: o.email } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// /api/ask matching
// ---------------------------------------------------------------------------

const ASK_STOPWORDS = new Set([
  'what', 'breaks', 'break', 'if', 'i', 'change', 'changes', 'changing',
  'the', 'a', 'an', 'in', 'of', 'to', 'do', 'does', 'will', 'would',
  'affect', 'affects', 'impact', 'impacts', 'which', 'functions', 'function',
]);

/** Score a single query token against one Function node; -1 = no match. */
function scoreToken(token: string, fn: GraphNode): number {
  const name = String(fn.props['name'] ?? '').toLowerCase();
  const qual = String(fn.props['qualifiedName'] ?? name).toLowerCase();
  const file = String(fn.props['file'] ?? '').toLowerCase();
  if (!token) return -1;
  if (name === token) return 100;
  if (qual === token) return 90;
  if (token.length >= 2 && name.includes(token)) return 70;
  if (token.length >= 2 && qual.includes(token)) return 60;
  if (token.length >= 3 && file.includes(token)) return 40;
  return -1;
}

type Store = Parameters<typeof owner_of>[0];

/** Best Function match for a natural-language question (case-insensitive). */
export async function findBestFunction(
  store: Store,
  q: string,
): Promise<GraphNode | null> {
  const fns = await store.findNodes('Function');
  if (fns.length === 0) return null;
  const full = q.toLowerCase().trim();
  const tokens = full
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !ASK_STOPWORDS.has(t));
  const queries = [full, ...tokens];
  let best: GraphNode | null = null;
  let bestScore = -1;
  for (const fn of fns) {
    for (const query of queries) {
      const s = scoreToken(query, fn);
      if (s > bestScore) {
        bestScore = s;
        best = fn;
      }
    }
  }
  return bestScore > 0 ? best : null;
}

export function functionBlastCypher(maxDepth = 5): string {
  return (
    'MATCH (src:Function {id: $functionId}) ' +
    `MATCH p = (src)-[:CALLS*1..${maxDepth}]->(affected:Function) ` +
    'RETURN affected, relationships(p) AS path'
  );
}

function shortName(fn: GraphNode): string {
  return String(fn.props['qualifiedName'] ?? fn.props['name'] ?? fn.id);
}

export function createApp(): express.Express {
  const app = express();
  // The UI is served from a different origin (Vercel) than the API
  // (Render) — without CORS the browser blocks every API call.
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'blastradius-server' });
  });

  // --- scan stats -----------------------------------------------------------
  app.get('/api/stats', async (req, res) => {
    const repo = String(req.query.repo ?? '');
    if (!repo) {
      res.status(400).json({ error: 'missing ?repo=<name> query param' });
      return;
    }
    if (!validRepoName(repo)) {
      res.status(400).json({ error: 'invalid repo name' });
      return;
    }
    try {
      const snapshot = await loadSnapshot(repo);
      if (!snapshot) throw new Error('no snapshot');
      res.json({ repo: snapshot.repo, scannedAt: snapshot.scannedAt, stats: snapshot.stats });
    } catch {
      res.status(404).json({
        error: `no scan snapshot for repo "${repo}" — run: npm run scan -- <repo-url-or-path>`,
      });
    }
  });

  // --- ranked findings ------------------------------------------------------
  app.get('/api/findings', async (req, res) => {
    const repo = String(req.query.repo ?? '');
    if (!repo) {
      res.status(400).json({ error: 'missing ?repo=<name> query param' });
      return;
    }
    if (!validRepoName(repo)) {
      res.status(400).json({ error: 'invalid repo name' });
      return;
    }
    const snapshot = await loadSnapshot(repo);
    if (!snapshot) {
      res.status(404).json({
        error: `no scan snapshot for repo "${repo}" — run: npm run scan -- <repo-url-or-path>`,
      });
      return;
    }
    const store = await hydrateStore(snapshot);
    const ranked = await impact_rank(store);
    const findings = await Promise.all(
      ranked.map(async (r) => {
        let owner: OwnerView | null = null;
        try {
          const br = await blast_radius(store, r.finding.id, 5);
          owner = await suggestedOwner(store, br.flagged);
        } catch {
          owner = null;
        }
        return {
          id: r.finding.id,
          ruleId: r.finding.props['ruleId'],
          severity: r.severity,
          title: r.finding.props['title'],
          description: r.finding.props['description'],
          file: r.finding.props['file'],
          line: r.finding.props['line'],
          status: r.finding.props['status'],
          score: r.score,
          blastSize: r.blastSize,
          avgDegree: r.avgDegree,
          owner,
        };
      }),
    );
    res.json({
      repo: snapshot.repo,
      scannedAt: snapshot.scannedAt,
      open: findings.length,
      findings,
    });
  });

  // --- blast-radius trace ---------------------------------------------------
  app.get('/api/blast-radius/:findingId', async (req, res) => {
    const repo = String(req.query.repo ?? '');
    const findingId = req.params.findingId;
    if (!repo) {
      res.status(400).json({ error: 'missing ?repo=<name> query param' });
      return;
    }
    if (!validRepoName(repo) || !validFindingId(findingId)) {
      res.status(400).json({ error: 'invalid repo name or finding id' });
      return;
    }
    const snapshot = await loadSnapshot(repo);
    if (!snapshot) {
      res.status(404).json({
        error: `no scan snapshot for repo "${repo}" — run: npm run scan -- <repo-url-or-path>`,
      });
      return;
    }
    const store = await hydrateStore(snapshot);
    try {
      const result = await blast_radius(store, findingId, 5);
      res.json({
        finding: {
          id: result.finding.id,
          ruleId: result.finding.props['ruleId'],
          severity: result.finding.props['severity'],
          title: result.finding.props['title'],
          file: result.finding.props['file'],
          line: result.finding.props['line'],
        },
        flagged: result.flagged
          ? {
              id: result.flagged.id,
              label: result.flagged.label,
              name: result.flagged.props['qualifiedName'] ?? result.flagged.props['name'],
              file: result.flagged.props['file'],
            }
          : null,
        nodes: result.nodes.map((n) => ({
          id: n.id,
          name: n.props['qualifiedName'] ?? n.props['name'],
          file: n.props['file'],
        })),
        edges: result.edges,
        cypher: result.cypher,
      });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- scan (Day 3): run the full pipeline from the UI ----------------------
  app.post('/api/scan', async (req, res) => {
    const body = (req.body ?? {}) as { repo?: unknown; memory?: unknown };
    const target = typeof body.repo === 'string' ? body.repo.trim() : '';
    const forceMemory = body.memory === true;
    if (!target || target.length > 500) {
      res.status(400).json({ error: 'body.repo must be a non-empty repo URL or local path (<= 500 chars)' });
      return;
    }
    const looksLikeUrl = URL_LIKE.test(target) || target.endsWith('.git');
    if (!looksLikeUrl && /[\0]/.test(target)) {
      res.status(400).json({ error: 'invalid repo path' });
      return;
    }
    try {
      const report = await runScan(target, { print: false, forceMemory });
      res.json({
        repo: report.repo,
        scannedAt: report.scannedAt,
        stats: report.stats,
        storeKind: report.storeKind,
        fallbackWarning: report.fallbackWarning,
        findings: report.findings.map((r) => ({
          id: r.finding.id,
          ruleId: r.finding.props['ruleId'],
          severity: r.severity,
          title: r.finding.props['title'],
          file: r.finding.props['file'],
          line: r.finding.props['line'],
          score: r.score,
          blastSize: r.blastSize,
        })),
      });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- ask (Day 3): "what breaks if I change X?" -----------------------------
  app.get('/api/ask', async (req, res) => {
    const repo = String(req.query.repo ?? '');
    const q = String(req.query.q ?? '').trim();
    if (!repo) {
      res.status(400).json({ error: 'missing ?repo=<name> query param' });
      return;
    }
    if (!validRepoName(repo)) {
      res.status(400).json({ error: 'invalid repo name' });
      return;
    }
    if (!q || q.length > 200) {
      res.status(400).json({ error: 'missing or too long ?q=<question> query param' });
      return;
    }
    const snapshot = await loadSnapshot(repo);
    if (!snapshot) {
      res.status(404).json({
        error: `no scan snapshot for repo "${repo}" — run: npm run scan -- <repo-url-or-path>`,
      });
      return;
    }
    const store = await hydrateStore(snapshot);
    const match = await findBestFunction(store, q);
    if (!match) {
      res.status(404).json({ error: `no function or file matching "${q.slice(0, 80)}"` });
      return;
    }
    const name = shortName(match);
    const file = String(match.props['file'] ?? '');

    // Prefer the enclosing open finding (explainability); otherwise trace the
    // function itself.
    const flaggers = (
      await store.neighbors(match.id, { type: 'FLAGGED_IN', direction: 'in' })
    ).filter((n) => n.label === 'Finding' && n.props['status'] !== 'fixed');

    let nodes: { id: string; name: unknown; file: unknown }[];
    let edges: { from: string; to: string }[];
    let cypher: string;
    let findingView: { id: string; ruleId: unknown; severity: unknown; title: unknown } | null = null;

    if (flaggers.length > 0) {
      const br = await blast_radius(store, flaggers[0].id, 5);
      nodes = br.nodes.map((n) => ({
        id: n.id,
        name: n.props['qualifiedName'] ?? n.props['name'],
        file: n.props['file'],
      }));
      edges = br.edges;
      cypher = br.cypher;
      findingView = {
        id: br.finding.id,
        ruleId: br.finding.props['ruleId'],
        severity: br.finding.props['severity'],
        title: br.finding.props['title'],
      };
    } else {
      const r = await reachableFunctions(store, match.id, 5);
      nodes = r.nodes.map((n) => ({
        id: n.id,
        name: n.props['qualifiedName'] ?? n.props['name'],
        file: n.props['file'],
      }));
      edges = r.edges;
      cypher = functionBlastCypher(5);
    }

    const topNames = nodes.slice(0, 5).map((n) => String(n.name));
    const owner = await suggestedOwner(store, match.label === 'Function' ? match : undefined);
    const summary =
      `Changing ${name} (${file}) may affect ${nodes.length} downstream ` +
      `function${nodes.length === 1 ? '' : 's'}` +
      (topNames.length > 0 ? `, including ${topNames.join(', ')}` : '') +
      '.' +
      (findingView
        ? ` It is flagged as ${String(findingView.severity)} by rule "${String(findingView.title)}".`
        : ' No open finding flags this function directly.') +
      (owner ? ` Suggested reviewer: ${owner.name} (${owner.email}).` : '');

    res.json({
      match: { id: match.id, name, file },
      finding: findingView,
      nodes,
      edges,
      cypher,
      summary,
    });
  });

  return app;
}
