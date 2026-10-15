import { readFile } from 'node:fs/promises';
import express from 'express';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'blastradius-server' });
});

// Day 1 (minimal): serve the stats of the last scan for a repo.
// The scanner writes server/.scan-cache/<repo>.json after every run.
// Full graph query API (findings, blast radius, agent tools) arrives Day 2.
app.get('/api/stats', async (req, res) => {
  const repo = String(req.query.repo ?? '');
  if (!repo) {
    res.status(400).json({ error: 'missing ?repo=<name> query param' });
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(repo)) {
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

app.listen(PORT, () => {
  console.log(`blastradius-server listening on :${PORT}`);
});
