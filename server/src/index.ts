// BlastRadius server entry point (Day 3).
//
// The Express app itself lives in app.ts (createApp) so tests can drive it
// with supertest without opening a port. This file only starts listening.

import { createApp } from './app.js';
import { seedDemoSnapshot } from './seed.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

async function main(): Promise<void> {
  // Render's filesystem is ephemeral: reinstall the bundled vuln-demo
  // snapshot so the UI's auto-loaded demo works after every redeploy.
  const seedResult = await seedDemoSnapshot();
  if (seedResult === 'seeded') console.log('[seed] bundled vuln-demo snapshot installed');

  createApp().listen(PORT, () => {
    console.log(`blastradius-server listening on :${PORT}`);
  });
}

void main();
