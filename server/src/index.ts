// BlastRadius server entry point (Day 3).
//
// The Express app itself lives in app.ts (createApp) so tests can drive it
// with supertest without opening a port. This file only starts listening.

import { createApp } from './app.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

createApp().listen(PORT, () => {
  console.log(`blastradius-server listening on :${PORT}`);
});
