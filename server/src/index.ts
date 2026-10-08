import express from 'express';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

// Placeholder only. Domain logic (ingestion, detection, agent) is built
// during the Graph Hacks event, Oct 15-18 2026.
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'blastradius-server' });
});

app.listen(PORT, () => {
  console.log(`blastradius-server listening on :${PORT}`);
});
