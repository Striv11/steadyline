import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDb, msUntilNextRun } from '../src/backup.js';
import { openDb } from '../src/db.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('backupDb', () => {
  it('writes a consistent, openable copy of the live database', async () => {
    const db = openDb(join(dir, 'live.db'));
    db.exec("CREATE TABLE IF NOT EXISTS probe(v TEXT); INSERT INTO probe VALUES ('hello')");
    const out = join(dir, 'b');
    const r = await backupDb(db, out, { now: new Date('2026-11-07T21:00:00Z') });
    expect(r.file.endsWith('care-20261107T210000Z.db')).toBe(true);
    // Writes after the snapshot do not appear in it.
    db.exec("INSERT INTO probe VALUES ('later')");
    const copy = new Database(r.file, { readonly: true });
    expect(copy.prepare('SELECT v FROM probe').all()).toEqual([{ v: 'hello' }]);
    expect(copy.prepare('SELECT count(*) c FROM users').get()).toEqual({ c: 0 });
    copy.close();
    expect(readdirSync(out).some((f) => f.endsWith('.partial'))).toBe(false);
    db.close();
  });

  it('keeps only the newest N snapshots and leaves other files alone', async () => {
    const db = openDb(':memory:');
    const out = join(dir, 'b');
    for (const day of ['05', '06', '07', '08'])
      await backupDb(db, out, { keep: 2, now: new Date(`2026-11-${day}T21:00:00Z`) });
    writeFileSync(join(out, 'notes.txt'), 'keep me');
    const r = await backupDb(db, out, { keep: 2, now: new Date('2026-11-09T21:00:00Z') });
    expect(readdirSync(out).sort()).toEqual([
      'care-20261108T210000Z.db',
      'care-20261109T210000Z.db',
      'notes.txt',
    ]);
    expect(r.pruned).toEqual(['care-20261107T210000Z.db']);
    db.close();
  });

  it('rejects an invalid retention and a failed backup leaves no partial file', async () => {
    const db = openDb(':memory:');
    await expect(backupDb(db, dir, { keep: 0 })).rejects.toThrow(/keep/);
    db.close();
    await expect(backupDb(db, join(dir, 'x'))).rejects.toThrow();
    expect(existsSync(join(dir, 'x')) ? readdirSync(join(dir, 'x')) : []).toEqual([]);
  });
});

describe('msUntilNextRun', () => {
  it('returns the time to the next occurrence of the hour', () => {
    expect(msUntilNextRun(new Date('2026-11-07T20:00:00Z'), 21)).toBe(3600_000);
    expect(msUntilNextRun(new Date('2026-11-07T21:00:00Z'), 21)).toBe(24 * 3600_000);
    expect(msUntilNextRun(new Date('2026-11-07T22:30:00Z'), 21)).toBe(22.5 * 3600_000);
  });
});
