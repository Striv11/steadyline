import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';

const NAME = /^care-(\d{8}T\d{6}Z)\.db$/;

export interface BackupResult {
  file: string;
  pruned: string[];
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Online, consistent snapshot of the live database (SQLite backup API, safe
 * while the server is writing). The copy is written under a temporary name,
 * verified with `PRAGMA integrity_check`, then renamed into place, so a
 * half-written or corrupt file never looks like a good backup. Only the
 * newest `keep` snapshots are retained; other files in the folder are left alone.
 */
export async function backupDb(
  db: DB,
  dir: string,
  opts: { keep?: number; now?: Date } = {},
): Promise<BackupResult> {
  const keep = opts.keep ?? 14;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer');
  mkdirSync(dir, { recursive: true });
  const name = `care-${stamp(opts.now ?? new Date())}.db`;
  const tmp = join(dir, `${name}.partial`);
  const final = join(dir, name);
  try {
    await db.backup(tmp);
    const copy = new Database(tmp, { readonly: true });
    try {
      const res = copy.pragma('integrity_check', { simple: true });
      if (res !== 'ok') throw new Error(`backup failed integrity check: ${String(res)}`);
    } finally {
      copy.close();
    }
    renameSync(tmp, final);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const all = readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort();
  const pruned = all.slice(0, Math.max(0, all.length - keep));
  for (const f of pruned) rmSync(join(dir, f), { force: true });
  return { file: final, pruned };
}

/** Milliseconds until the next occurrence of `hourUtc`:00 UTC after `now`. */
export function msUntilNextRun(now: Date, hourUtc: number): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Run `backupDb` every night at `hourUtc`. Returns a function that stops the schedule. */
export function scheduleNightlyBackup(
  db: DB,
  dir: string,
  opts: { keep?: number; hourUtc?: number; log?: (m: string) => void } = {},
): () => void {
  const log = opts.log ?? console.log;
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(
      () => {
        backupDb(db, dir, { keep: opts.keep })
          .then((r) => log(`Backup written: ${r.file} (pruned ${r.pruned.length})`))
          .catch((e) => log(`Backup FAILED: ${(e as Error).message}`))
          .finally(arm);
      },
      msUntilNextRun(new Date(), opts.hourUtc ?? 21),
    );
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
