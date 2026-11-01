import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(file = process.env['DB_FILE'] ?? 'care.db'): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schemaFile = [join(here, 'schema.sql'), join(here, '..', 'src', 'schema.sql')].find((f) => {
    try {
      readFileSync(f);
      return true;
    } catch {
      return false;
    }
  });
  db.exec(readFileSync(schemaFile!, 'utf8'));
  return db;
}

export const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const now = () => new Date().toISOString();

export function audit(
  db: DB,
  userId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  detail?: unknown,
): void {
  db.prepare(
    'INSERT INTO audit (at, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    now(),
    userId,
    action,
    entity,
    entityId,
    detail === undefined ? null : JSON.stringify(detail),
  );
}
