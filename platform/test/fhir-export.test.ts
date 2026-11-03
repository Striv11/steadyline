/** The patient's FHIR export must be accepted by the local-first dashboard's own validator. */
import { beforeEach, describe, expect, it } from 'vitest';
import { validateBundle } from '../../src/domain/validate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { id, openDb, type DB } from '../src/db.js';
import { Notifier } from '../src/notify.js';
import { buildExportBundle } from '../src/domain/fhir.js';

let db: DB;
let app: ReturnType<typeof buildApp>;

function user(role: string, phone: string) {
  db.prepare(
    'INSERT INTO users (id, role, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'u_' + phone,
    role,
    'User ' + phone,
    phone,
    hashPassword('password123'),
    new Date().toISOString(),
  );
  if (role === 'patient')
    db.prepare("INSERT INTO patients (user_id, date_of_birth) VALUES (?, '1960-04-02')").run(
      'u_' + phone,
    );
}
function obs(patient: string, code: string, value: number, value2: number | null, at: string) {
  db.prepare(
    'INSERT INTO observations (id, patient_id, code, loinc, value, value2, unit, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id('obs'), patient, code, 'x', value, value2, 'u', 'u_9000000001', at);
}
const tok = async (phone: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { phone, password: 'password123' },
    })
  ).json().token as string;
const get = async (phone: string, url = '/api/me/export.fhir.json') =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await tok(phone)}` } });

beforeEach(() => {
  db = openDb(':memory:');
  app = buildApp({
    db,
    secret: 's',
    notifier: new Notifier(db, { name: 'log', send: async () => ({ ref: 'x' }) }),
  });
  user('admin', '9000000001');
  user('patient', '9300000001');
  user('patient', '9300000002');
  obs('u_9300000001', 'bp', 142, 91, '2026-10-01T05:00:00.000Z');
  obs('u_9300000001', 'glucose', 128, null, '2026-10-01T05:01:00.000Z');
  obs('u_9300000001', 'spo2', 97, null, '2026-11-01T05:00:00.000Z');
  obs('u_9300000001', 'temp', 37.1, null, '2026-11-01T05:00:00.000Z');
  obs('u_9300000001', 'rr', 16, null, '2026-11-01T05:00:00.000Z');
  obs('u_9300000002', 'hr', 70, null, '2026-11-01T05:00:00.000Z');
});

describe('GET /api/me/export.fhir.json', () => {
  it('returns a Bundle the dashboard validator accepts, with only my data', async () => {
    const res = await get('9300000001');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/fhir+json');
    const b = res.json();
    expect(validateBundle(b)).toEqual([]);
    const types = b.entry.map((e: any) => e.resource.resourceType);
    expect(types.filter((t: string) => t === 'Patient')).toHaveLength(1);
    expect(types.filter((t: string) => t === 'Observation')).toHaveLength(5);
    expect(JSON.stringify(b)).not.toContain('9300000002');
    expect(b.entry[0].resource.birthDate).toBe('1960-04-02');
  });

  it('maps BP to a panel with systolic and diastolic components', async () => {
    const b = (await get('9300000001')).json();
    const bp = b.entry
      .map((e: any) => e.resource)
      .find((r: any) => r.code?.coding[0].code === '85354-9');
    expect(bp.component.map((c: any) => [c.code.coding[0].code, c.valueQuantity.value])).toEqual([
      ['8480-6', 142],
      ['8462-4', 91],
    ]);
  });

  it('filters with ?since and rejects a bad date', async () => {
    const b = (await get('9300000001', '/api/me/export.fhir.json?since=2026-10-15')).json();
    expect(b.entry.filter((e: any) => e.resource.resourceType === 'Observation')).toHaveLength(3);
    expect((await get('9300000001', '/api/me/export.fhir.json?since=yesterday')).statusCode).toBe(
      400,
    );
  });

  it('is patient-only and audited', async () => {
    expect((await get('9000000001')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/me/export.fhir.json' })).statusCode).toBe(
      401,
    );
    await get('9300000001');
    const row = db
      .prepare("SELECT COUNT(*) n FROM audit WHERE action = 'export_fhir'")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('exports an empty history as just the patient and skips malformed BP rows', () => {
    const b = buildExportBundle(
      { id: 'u_1', name: 'A', date_of_birth: null },
      [
        {
          id: 'obs_1',
          code: 'bp',
          value: 120,
          value2: null,
          recorded_at: '2026-11-01T00:00:00.000Z',
        },
      ],
      '2026-11-03T00:00:00.000Z',
    );
    expect(b.entry).toHaveLength(1);
    expect(validateBundle(b)).toEqual([]);
  });
});
