import { openDb } from './db.js';
import { backupDb } from './backup.js';

// Usage: npm run backup -- [dir] [keep]   (defaults: $BACKUP_DIR or ./backups, 14)
const dir = process.argv[2] ?? process.env['BACKUP_DIR'] ?? 'backups';
const keep = Number(process.argv[3] ?? process.env['BACKUP_KEEP'] ?? 14);
const db = openDb();
try {
  const r = await backupDb(db, dir, { keep });
  console.log(`Backup written: ${r.file}${r.pruned.length ? ` (pruned ${r.pruned.length})` : ''}`);
} catch (e) {
  console.error(`Backup failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
