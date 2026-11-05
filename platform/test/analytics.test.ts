import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { openDb, type DB } from '../src/db.js';
import { Notifier } from '../src/notify.js';
import {
  alertResponse,
  outcomes,
  percentile,
  revenueByService,
  staffUtilization,
  toCsv,
  type JobRow,
} from '../src/domain/analytics.js';

const job = (o: Partial<JobRow>): JobRow => ({
  id: 'j',
  service_id: 's1',
  service_name: 'Nursing',
  staff_id: 'a',
  status: 'completed',
  starts_at: '2026-10-01T04:00:00.000Z',
  ends_at: '2026-10-01T05:00:00.000Z',
  price_paise: 50000,
  payment_status: 'paid',
  ...o,
});

describe('analytics math', () => {
  it('percentile uses nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
  });
  it('utilization counts staffed non-cancelled visits against shifts', () => {
    const u = staffUtilization(
      [
        job({}),
        job({ status: 'no_show' }),
        job({ status: 'cancelled' }),
        job({ status: 'requested', staff_id: null }),
        job({ staff_id: 'b' }),
      ],
      [
        {
          staff_id: 'a',
          starts_at: '2026-10-01T03:00:00.000Z',
          ends_at: '2026-10-01T11:00:00.000Z',
        },
      ],
    );
    const a = u.find((x) => x.staff_id === 'a')!;
    expect(a).toMatchObject({
      jobs: 2,
      booked_minutes: 120,
      shift_minutes: 480,
      utilization: 0.25,
    });
    expect(u.find((x) => x.staff_id === 'b')!.utilization).toBeNull();
  });
  it('revenue only counts completed visits; waived is not billed', () => {
    const r = revenueByService([
      job({}),
      job({ payment_status: 'unpaid' }),
      job({ payment_status: 'waived' }),
      job({ status: 'cancelled' }),
    ]);
    expect(r).toEqual([
      {
        service_id: 's1',
        service_name: 'Nursing',
        completed: 3,
        billed_paise: 100000,
        collected_paise: 50000,
      },
    ]);
  });
  it('outcome rates are over final states', () => {
    const o = outcomes([
      job({}),
      job({}),
      job({ status: 'cancelled' }),
      job({ status: 'no_show' }),
      job({ status: 'assigned' }),
    ]);
    expect(o).toMatchObject({
      total: 5,
      completed: 2,
      cancellation_rate: 0.25,
      no_show_rate: 0.25,
    });
    expect(outcomes([]).cancellation_rate).toBeNull();
  });
  it('alert response ignores warnings and counts unacknowledged', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
    const r = alertResponse([
      { severity: 'critical', created_at: t(0), acknowledged_at: t(4) },
      { severity: 'critical', created_at: t(0), acknowledged_at: t(10) },
      { severity: 'critical', created_at: t(0), acknowledged_at: null },
      { severity: 'warning', created_at: t(0), acknowledged_at: t(1) },
    ]);
    expect(r).toEqual({
      critical: 3,
      acknowledged: 2,
      unacknowledged: 1,
      median_minutes: 4,
      p90_minutes: 10,
    });
  });
  it('csv quotes and defuses formulas', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', '=SUM(1)'],
          ['say "hi"', null],
          [-3, '-cmd'],
        ],
      ),
    ).toBe('a,b\r\n"x,y",\'=SUM(1)\r\n"say ""hi""",\r\n-3,\'-cmd\r\n');
  });
});

describe('GET /api/ops/analytics', () => {
  let db: DB;
  let app: ReturnType<typeof buildApp>;
  const add = (role: string, phone: string, name = 'U' + phone) =>
    db
      .prepare(
        'INSERT INTO users (id, role, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('u_' + phone, role, name, phone, hashPassword('password123'), '2026-10-01T00:00:00Z');
  const tok = async (phone: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { phone, password: 'password123' },
      })
    ).json().token as string;
  const get = async (phone: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await tok(phone)}` } });

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildApp({
      db,
      secret: 's',
      notifier: new Notifier(db, { name: 'log', send: async () => ({ ref: 'x' }) }),
    });
    add('ops', '9000000001');
    add('patient', '9300000001');
    add('caregiver', '9100000001', '=Nurse');
    db.prepare(
      "INSERT INTO staff (user_id, home_lat, home_lng) VALUES ('u_9100000001', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO services (id, name, kind, skill, duration_min, price_paise) VALUES ('s1','Nursing','home_visit','nurse',60,50000)",
    ).run();
    const ins = db.prepare(
      `INSERT INTO jobs (id, patient_id, service_id, kind, status, starts_at, ends_at, address, staff_id, price_paise, payment_status, created_at, updated_at)
       VALUES (?, 'u_9300000001', 's1', 'home_visit', ?, ?, ?, 'x', 'u_9100000001', 50000, ?, 'n', 'n')`,
    );
    ins.run('j1', 'completed', '2026-10-01T04:00:00.000Z', '2026-10-01T05:00:00.000Z', 'paid');
    ins.run('j2', 'cancelled', '2026-10-02T04:00:00.000Z', '2026-10-02T05:00:00.000Z', 'unpaid');
    ins.run('j3', 'completed', '2026-09-01T04:00:00.000Z', '2026-09-01T05:00:00.000Z', 'paid'); // outside window
    db.prepare(
      "INSERT INTO shifts (id, staff_id, starts_at, ends_at) VALUES ('sh1','u_9100000001','2026-10-01T03:00:00.000Z','2026-10-01T07:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO alerts (id, patient_id, severity, message, created_at, acknowledged_at) VALUES ('a1','u_9300000001','critical','m','2026-10-01T06:00:00.000Z','2026-10-01T06:03:00.000Z')",
    ).run();
  });

  it('returns window-limited metrics', async () => {
    const r = await get('9000000001', '/api/ops/analytics?from=2026-10-01&to=2026-10-31');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.outcomes).toMatchObject({
      total: 2,
      completed: 1,
      cancelled: 1,
      cancellation_rate: 0.5,
    });
    expect(b.services[0]).toMatchObject({ completed: 1, billed_paise: 50000 });
    expect(b.staff[0]).toMatchObject({ jobs: 1, utilization: 0.25 });
    expect(b.alerts).toMatchObject({ critical: 1, median_minutes: 3 });
  });
  it('exports csv, audits it and defuses names', async () => {
    const r = await get(
      '9000000001',
      '/api/ops/analytics?from=2026-10-01&to=2026-10-31&report=staff&format=csv',
    );
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body).toContain("u_9100000001,'=Nurse,1,60,240,0.25");
    expect(
      db.prepare("SELECT COUNT(*) n FROM audit WHERE action='export_analytics'").get(),
    ).toEqual({ n: 1 });
  });
  it('validates input and roles', async () => {
    expect(
      (await get('9000000001', '/api/ops/analytics?from=2026-11-02&to=2026-11-01')).statusCode,
    ).toBe(400);
    expect((await get('9000000001', '/api/ops/analytics?format=csv')).statusCode).toBe(400);
    expect((await get('9300000001', '/api/ops/analytics')).statusCode).toBe(403);
  });
});
