import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { config } from './config.js';
import { initSchema, seedMachinesFromMapping } from './db/index.js';
import { api } from './routes.js';
import { runLidatSync } from './sync/lidatSync.js';
import { seedAdmin } from './services/users.js';

function bootstrap(): void {
  initSchema();
  const seed = seedMachinesFromMapping();
  console.log(`[db] machines seeded: ${seed.inserted} new of ${seed.total} in mapping`);

  if (config.auth.jwtSecretIsDefault) {
    console.warn('[auth] JWT_SECRET is not set — using an insecure dev default. Set JWT_SECRET in production.');
  }
  seedAdmin(config.auth.adminUsername, config.auth.adminPassword);

  const app = express();
  app.use(cors(config.corsOrigin ? { origin: config.corsOrigin } : undefined));
  // Reports are posted as base64 for e-mailing, so the default 100 kb JSON limit
  // is far too small. 8 MB comfortably covers the ~2.5 MB attachment cap plus
  // base64's ~33% overhead (see services/mailer.ts).
  app.use(express.json({ limit: '8mb' }));
  app.use('/api', api);

  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
  });

  // Schedule the recurring LiDAT history sync.
  if (cron.validate(config.sync.cron)) {
    cron.schedule(config.sync.cron, () => {
      console.log('[sync] scheduled run starting');
      runLidatSync()
        .then((r) => console.log('[sync] done:', r))
        .catch((err) => console.error('[sync] error:', err));
    });
    console.log(`[sync] scheduled with cron "${config.sync.cron}"`);
  } else {
    console.warn(`[sync] invalid cron expression: "${config.sync.cron}" — scheduler disabled`);
  }

  if (config.sync.onStart) {
    console.log('[sync] running initial sync on startup');
    runLidatSync()
      .then((r) => console.log('[sync] initial done:', r))
      .catch((err) => console.error('[sync] initial error:', err));
  }
}

bootstrap();
