import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { bootstrap, demo } from './seed.js';

const secret = process.env['SESSION_SECRET'];
if (!secret && process.env['NODE_ENV'] === 'production') {
  console.error('SESSION_SECRET must be set in production (32+ random bytes).');
  process.exit(1);
}
const db = openDb();
if (process.env['SEED_DEMO'] === '1' && demo(db)) console.log('Seeded demo data (SEED_DEMO=1).');
const adminPhone = process.env['ADMIN_PHONE'];
const adminPassword = process.env['ADMIN_PASSWORD'];
if (adminPhone && adminPassword && bootstrap(db, adminPhone, adminPassword))
  console.log('Created the admin account and the service catalog.');
const app = buildApp({
  db,
  secret: secret ?? randomBytes(32).toString('hex'),
  corsOrigin: process.env['CORS_ORIGIN'] ?? true,
  publicDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
});
const port = Number(process.env['PORT'] ?? 8787);
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`care-server listening on :${port}`));
// Keep each care plan staffed two weeks ahead.
const generate = () => {
  try {
    const n = app.generatePlans();
    if (n) console.log(`care plans: created ${n} visits`);
  } catch (e) {
    console.error('care plan generation failed', e);
  }
};
setTimeout(generate, 5_000).unref();
setInterval(generate, 60 * 60_000).unref();
