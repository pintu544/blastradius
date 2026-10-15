import { readFile } from 'node:fs/promises';
import express from 'express';
import { blast_radius, impact_rank } from './agent/tools.js';
import { hydrateStore, loadSnapshot } from './graph/snapshot.js';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'blastradius-server' });
});

function validRepoName(repo: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(repo);
}

// Day 1 (minimal): serve the stats of the last scan for a repo.
// The scanner writes server/.scan-cache/<repo>.json after every run.
// Full graph query API (findings, blast radius, agent tools) arrives Day 2.
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
    const raw = await readFile(new URL(`../.scan-cache/${repo}.json`, import.meta.url), 'utf8');
    const snapshot = JSON.parse(raw) as { repo: string; scannedAt: string; stats: unknown };
    res.json({ repo: snapshot.repo, scannedAt: snapshot.scannedAt, stats: snapshot.stats });
  } catch {
    res.status(404).json({
      error: `no scan snapshot for repo "${repo}" — run: npm run scan -- <repo-url-or-path>`,
    });
  }
});

// Day 2: ranked open findings for a repo (severity x blast-radius x centrality).
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
  res.json({
    repo: snapshot.repo,
    scannedAt: snapshot.scannedAt,
    open: ranked.length,
    findings: ranked.map((r) => ({
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
    })),
  });
});

// Day 2: blast-radius trace for one finding (nodes + path edges + the Cypher).
app.get('/api/blast-radius/:findingId', async (req, res) => {
  const repo = String(req.query.repo ?? '');
  const findingId = req.params.findingId;
  if (!repo) {
    res.status(400).json({ error: 'missing ?repo=<name> query param' });
    return;
  }
  if (!validRepoName(repo) || !/^[A-Za-z0-9:_\-./#]+$/.test(findingId)) {
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

app.listen(PORT, () => {
  console.log(`blastradius-server listening on :${PORT}`);
});
