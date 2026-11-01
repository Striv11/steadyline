// Fresh database, seed, then start the server (used by Playwright's webServer).
import { execSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const env = {
  ...process.env,
  DB_FILE: 'e2e.db',
  SEED_PASSWORD: 'changeme123',
  PORT: '8799',
  SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret',
};
for (const f of ['e2e.db', 'e2e.db-wal', 'e2e.db-shm']) rmSync(f, { force: true });
execSync('npx tsx src/seed.ts', { env, stdio: 'inherit' });
const p = spawn('npx', ['tsx', 'src/main.ts'], { env, stdio: 'inherit', shell: true });
process.on('SIGTERM', () => p.kill());
