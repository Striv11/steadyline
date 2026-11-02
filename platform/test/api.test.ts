/**
 * End-to-end business flows through the real HTTP layer and a real SQLite
 * database (in memory): booking, auto-dispatch, a home visit with vitals and
 * a critical alert, a medicine delivery with OTP, clinic visits, permissions,
 * and the append-only audit trail.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { id, openDb, type DB } from '../src/db.js';
import { Notifier, type Provider } from '../src/notify.js';

type App = ReturnType<typeof buildApp>;
let db: DB;
let app: App;
let notifier: Notifier;
let sent: { to: string; body: string }[] = [];
let failSends = false;
const fakeProvider: Provider = {
  name: 'fake',
  send: async (to, body) => {
    if (failSends) throw new Error('provider down');
    sent.push({ to, body });
    return { ref: `m${sent.length}` };
  },
};
const PW = 'password123';

const tomorrowAt = (hhmmUtc: string) =>
  `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T${hhmmUtc}:00.000Z`;

function seed() {
  const pw = hashPassword(PW);
  const user = (role: string, name: string, phone: string) => {
    const uid = id('usr');
    db.prepare(
      'INSERT INTO users (id, role, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(uid, role, name, phone, pw, new Date().toISOString());
    return uid;
  };
  const clinic = id('site');
  db.prepare('INSERT INTO sites VALUES (?, ?, ?, ?, ?, ?)').run(
    clinic,
    'Clinic',
    'Main Rd',
    18.5,
    73.8,
    'clinic',
  );
  const svc = (kind: string, name: string, skill: string, dur: number) => {
    const sid = id('svc');
    db.prepare(
      'INSERT INTO services (id, name, kind, skill, duration_min, price_paise) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sid, name, kind, skill, dur, 50000);
    return sid;
  };
  const services = {
    nursing: svc('home_visit', 'Nursing', 'nursing', 45),
    delivery: svc('delivery', 'Delivery', 'delivery', 30),
    consult: svc('clinic_visit', 'Consult', 'doctor', 30),
    physio: svc('home_visit', 'Physio', 'physio', 60),
  };
  const staff = (
    role: string,
    name: string,
    phone: string,
    skills: string[],
    lat: number,
    lng: number,
    site: string | null = null,
  ) => {
    const uid = user(role, name, phone);
    db.prepare(
      'INSERT INTO staff (user_id, skills, home_lat, home_lng, site_id) VALUES (?, ?, ?, ?, ?)',
    ).run(uid, JSON.stringify(skills), lat, lng, site);
    const day = tomorrowAt('00:00').slice(0, 10);
    db.prepare('INSERT INTO shifts (id, staff_id, starts_at, ends_at) VALUES (?, ?, ?, ?)').run(
      id('shf'),
      uid,
      `${day}T02:30:00.000Z`,
      `${day}T14:30:00.000Z`,
    );
    return uid;
  };
  return {
    clinic,
    services,
    admin: user('admin', 'Admin', '9000000001'),
    ops: user('ops', 'Ops', '9000000002'),
    nurseNear: staff('caregiver', 'Nurse Near', '9100000001', ['nursing'], 18.49, 73.82),
    nurseFar: staff('caregiver', 'Nurse Far', '9100000002', ['nursing'], 18.62, 73.95),
    doctor: staff('caregiver', 'Doctor', '9100000003', ['doctor'], 18.5, 73.8, clinic),
    courier: staff('courier', 'Courier', '9200000001', ['delivery'], 18.5, 73.83),
  };
}

let S: ReturnType<typeof seed>;
beforeEach(() => {
  db = openDb(':memory:');
  sent = [];
  failSends = false;
  notifier = new Notifier(db, fakeProvider);
  app = buildApp({ db, secret: 'test-secret', notifier });
  S = seed();
});

async function call(method: 'GET' | 'POST' | 'PUT', url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
const login = async (phone: string) =>
  (await call('POST', '/api/auth/login', undefined, { phone, password: PW })).body[
    'token'
  ] as string;

async function newPatient() {
  const r = await call('POST', '/api/auth/register', undefined, {
    name: 'Sunita',
    phone: '9300000001',
    password: PW,
    consent: true,
  });
  expect(r.status).toBe(200);
  const token = r.body['token'] as string;
  const p = await call('PUT', '/api/patient/profile', token, {
    address: 'Karve Nagar, Pune',
    lat: 18.488,
    lng: 73.818,
    conditions: ['type 2 diabetes'],
    allergies: ['penicillin'],
  });
  expect(p.status).toBe(200);
  return token;
}

describe('accounts', () => {
  it('requires consent and unique phone, rejects bad passwords', async () => {
    expect(
      (
        await call('POST', '/api/auth/register', undefined, {
          name: 'X',
          phone: '9300000009',
          password: PW,
        })
      ).status,
    ).toBe(400);
    await newPatient();
    expect(
      (
        await call('POST', '/api/auth/register', undefined, {
          name: 'Yash',
          phone: '9300000001',
          password: PW,
          consent: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('POST', '/api/auth/login', undefined, { phone: '9300000001', password: 'nope' }))
        .status,
    ).toBe(401);
    expect((await call('GET', '/api/me')).status).toBe(401);
  });
});

describe('home visit, end to end', () => {
  it('books, auto-dispatches the nearest nurse, records vitals, raises and resolves a critical alert', async () => {
    const pt = await newPatient();
    const book = await call('POST', '/api/jobs', pt, {
      service_id: S.services.nursing,
      starts_at: tomorrowAt('05:00'),
      notes: 'Ring twice',
    });
    expect(book.status).toBe(200);
    const job = book.body['job'];
    expect(book.body['dispatch'].assigned.name).toBe('Nurse Near');
    expect(job.status).toBe('assigned');
    expect(job.staff.name).toBe('Nurse Near');
    expect(job.patient).toBeUndefined(); // patients get their own view

    const nurse = await login('9100000001');
    const day = (
      await call('GET', `/api/staff/today?date=${tomorrowAt('00:00').slice(0, 10)}`, nurse)
    ).body as unknown as any[];
    expect(day).toHaveLength(1);
    expect(day[0].patient.allergies).toEqual(['penicillin']); // need-to-know for the visit

    // Other nurse cannot touch it; patient cannot record vitals.
    const other = await login('9100000002');
    expect((await call('POST', `/api/jobs/${job.id}/actions/start`, other)).status).toBe(404);
    expect(
      (await call('POST', `/api/jobs/${job.id}/observations`, pt, [{ code: 'hr', value: 70 }]))
        .status,
    ).toBe(403);

    expect(
      (await call('POST', `/api/jobs/${job.id}/observations`, nurse, [{ code: 'hr', value: 70 }]))
        .status,
    ).toBe(409); // not there yet
    for (const a of ['start', 'arrive', 'begin'])
      expect(
        (
          await call('POST', `/api/jobs/${job.id}/actions/${a}`, nurse, {
            lat: 18.488,
            lng: 73.818,
          })
        ).status,
      ).toBe(200);

    expect(
      (
        await call('POST', `/api/jobs/${job.id}/observations`, nurse, [
          { code: 'spo2', value: 140 },
        ])
      ).status,
    ).toBe(400);
    const vit = await call('POST', `/api/jobs/${job.id}/observations`, nurse, [
      { code: 'bp', value: 186, value2: 112 },
      { code: 'glucose', value: 142 },
    ]);
    expect(vit.status).toBe(200);
    expect(vit.body['alerts']).toHaveLength(1);
    expect(vit.body['alerts'][0].severity).toBe('critical');

    const done = await call('POST', `/api/jobs/${job.id}/actions/complete`, nurse, {
      visit_notes: 'BP high, advised doctor review today.',
      payment_status: 'paid',
      payment_method: 'upi',
    });
    expect(done.status).toBe(200);
    expect(done.body['status']).toBe('completed');
    expect(done.body['events'].map((e: any) => e.status)).toEqual([
      'requested',
      'assigned',
      'en_route',
      'arrived',
      'in_progress',
      'completed',
    ]);

    // Patient sees their readings and can rate.
    const obs = await call('GET', '/api/patient/observations', pt);
    expect((obs.body as unknown as any[]).map((o) => o.code)).toEqual(['bp', 'glucose']);
    expect((await call('POST', `/api/jobs/${job.id}/rating`, pt, { rating: 5 })).status).toBe(200);

    // Ops sees and resolves the alert.
    const ops = await login('9000000002');
    const alerts = (await call('GET', '/api/ops/alerts', ops)).body as unknown as any[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].patient_name).toBe('Sunita');
    expect(
      (
        await call('POST', `/api/ops/alerts/${alerts[0].id}/ack`, ops, {
          resolution: 'Called patient; GP appointment booked for 4pm.',
        })
      ).status,
    ).toBe(200);
    expect((await call('GET', '/api/ops/alerts', ops)).body).toEqual([]);
    const m = await call('GET', '/api/ops/metrics', ops);
    expect(m.body['revenue_paid_paise']).toBe(50000);
    expect(m.body['avg_rating']).toBe(5);
  });

  it('queues jobs nobody can take, then ops assigns manually', async () => {
    const pt = await newPatient();
    const book = await call('POST', '/api/jobs', pt, {
      service_id: S.services.physio,
      starts_at: tomorrowAt('05:00'),
    });
    expect(book.body['job'].status).toBe('requested');
    expect(book.body['dispatch'].reason).toMatch(/ops queue/);
    const ops = await login('9000000002');
    const cands = await call('GET', `/api/jobs/${book.body['job'].id}/candidates`, ops);
    expect(cands.body['eligible']).toEqual([]);
    const a = await call('POST', `/api/jobs/${book.body['job'].id}/actions/assign`, ops, {
      staff_id: S.nurseFar,
    });
    expect(a.status).toBe(200);
    expect(a.body['events'].at(-1).note).toMatch(/manual override/);
  });

  it('does not double-book: the second overlapping visit goes to the other nurse', async () => {
    const pt = await newPatient();
    await call('POST', '/api/jobs', pt, {
      service_id: S.services.nursing,
      starts_at: tomorrowAt('05:00'),
    });
    const second = await call('POST', '/api/jobs', pt, {
      service_id: S.services.nursing,
      starts_at: tomorrowAt('05:15'),
    });
    expect(second.body['dispatch'].assigned.name).toBe('Nurse Far');
  });

  it('lets patients cancel only before the nurse leaves', async () => {
    const pt = await newPatient();
    const j = (
      await call('POST', '/api/jobs', pt, {
        service_id: S.services.nursing,
        starts_at: tomorrowAt('05:00'),
      })
    ).body['job'];
    const nurse = await login('9100000001');
    await call('POST', `/api/jobs/${j.id}/actions/start`, nurse);
    const c = await call('POST', `/api/jobs/${j.id}/actions/cancel`, pt, {
      reason: 'feeling better',
    });
    expect(c.status).toBe(409);
    expect(c.body['error']).toMatch(/on the way/);
  });
});

describe('delivery with OTP', () => {
  it('only the patient sees the code; courier must enter it', async () => {
    const pt = await newPatient();
    const b = await call('POST', '/api/jobs', pt, {
      service_id: S.services.delivery,
      starts_at: tomorrowAt('06:00'),
      items: [{ name: 'Metformin 500mg strip', qty: 2 }],
    });
    expect(b.status).toBe(200);
    const code = b.body['job'].otp_code as string;
    expect(code).toMatch(/^\d{6}$/);
    expect(b.body['dispatch'].assigned.name).toBe('Courier');
    const courier = await login('9200000001');
    const seen = await call('GET', `/api/jobs/${b.body['job'].id}`, courier);
    expect(seen.body['otp_code']).toBeUndefined();
    await call('POST', `/api/jobs/${b.body['job'].id}/actions/start`, courier);
    await call('POST', `/api/jobs/${b.body['job'].id}/actions/arrive`, courier);
    expect(
      (await call('POST', `/api/jobs/${b.body['job'].id}/actions/complete`, courier)).status,
    ).toBe(400);
    const wrong = code === '000000' ? '111111' : '000000';
    expect(
      (
        await call('POST', `/api/jobs/${b.body['job'].id}/actions/complete`, courier, {
          otp: wrong,
        })
      ).body['error'],
    ).toMatch(/does not match/);
    const ok = await call('POST', `/api/jobs/${b.body['job'].id}/actions/complete`, courier, {
      otp: code,
      payment_status: 'paid',
      payment_method: 'cash',
    });
    expect(ok.body['status']).toBe('completed');
  });
  it('requires items', async () => {
    const pt = await newPatient();
    expect(
      (
        await call('POST', '/api/jobs', pt, {
          service_id: S.services.delivery,
          starts_at: tomorrowAt('06:00'),
        })
      ).status,
    ).toBe(400);
  });
});

describe('clinic visit', () => {
  it('books at a clinic and assigns that clinic’s doctor; check-in skips travel', async () => {
    const pt = await newPatient();
    const b = await call('POST', '/api/jobs', pt, {
      service_id: S.services.consult,
      starts_at: tomorrowAt('07:00'),
      site_id: S.clinic,
    });
    expect(b.body['dispatch'].assigned.name).toBe('Doctor');
    expect(b.body['job'].site.name).toBe('Clinic');
    const doc = await login('9100000003');
    expect(
      (await call('POST', `/api/jobs/${b.body['job'].id}/actions/arrive`, doc)).body['status'],
    ).toBe('arrived');
  });
});

describe('admin and audit', () => {
  it('admin creates staff and shifts; ops cannot create staff; audit is append-only', async () => {
    const admin = await login('9000000001');
    const ops = await login('9000000002');
    const body = {
      role: 'caregiver',
      name: 'New Nurse',
      phone: '9100000099',
      password: PW,
      skills: ['nursing'],
      home_lat: 18.5,
      home_lng: 73.8,
    };
    expect((await call('POST', '/api/ops/staff', ops, body)).status).toBe(403);
    const s = await call('POST', '/api/ops/staff', admin, body);
    expect(s.status).toBe(200);
    expect(
      (
        await call('POST', '/api/ops/shifts', ops, {
          staff_id: s.body['id'],
          starts_at: tomorrowAt('02:30'),
          ends_at: tomorrowAt('02:00'),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/ops/shifts', ops, {
          staff_id: s.body['id'],
          starts_at: tomorrowAt('02:30'),
          ends_at: tomorrowAt('10:30'),
        })
      ).status,
    ).toBe(200);
    const log = (await call('GET', '/api/ops/audit', admin)).body as unknown as any[];
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining(['create_staff', 'create_shift', 'login']),
    );
    expect(() => db.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE audit SET action = 'x'").run()).toThrow(/append-only/);
  });
  it('disabled accounts lose access immediately', async () => {
    const admin = await login('9000000001');
    const nurse = await login('9100000001');
    await call('POST', `/api/ops/staff/${S.nurseNear}/active`, admin, { active: false });
    expect((await call('GET', '/api/me', nurse)).status).toBe(401);
  });
  it('ops board summarizes the day', async () => {
    const pt = await newPatient();
    await call('POST', '/api/jobs', pt, {
      service_id: S.services.nursing,
      starts_at: tomorrowAt('05:00'),
    });
    const ops = await login('9000000002');
    const b = await call('GET', `/api/ops/board?date=${tomorrowAt('00:00').slice(0, 10)}`, ops);
    expect(b.body['counts']).toEqual({ assigned: 1 });
    expect(b.body['staff'].find((s: any) => s.name === 'Nurse Near').jobs_today).toBe(1);
  });
});

describe('production bootstrap', () => {
  it('creates only the admin and the catalog, once, with a strong password', async () => {
    const { bootstrap } = await import('../src/seed.js');
    const fresh = openDb(':memory:');
    expect(() => bootstrap(fresh, '9000000099', 'short')).toThrow(/12 characters/);
    expect(bootstrap(fresh, '9000000099', 'a-long-admin-password')).toBe(true);
    expect(bootstrap(fresh, '9000000099', 'a-long-admin-password')).toBe(false);
    const roles = fresh.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all();
    expect(roles).toEqual([{ role: 'admin', n: 1 }]);
    expect((fresh.prepare('SELECT COUNT(*) AS n FROM services').get() as { n: number }).n).toBe(9);
  });
});

describe('catalog administration', () => {
  it('admin adds a clinic and a service, changes a price without touching booked jobs, retires a service', async () => {
    const admin = await login('9000000001');
    const ops = await login('9000000002');
    const site = {
      name: 'Baner Clinic',
      address: 'Baner Road, Pune 411045',
      lat: 18.559,
      lng: 73.786,
      kind: 'clinic',
    };
    expect((await call('POST', '/api/ops/sites', ops, site)).status).toBe(403);
    expect((await call('POST', '/api/ops/sites', admin, site)).status).toBe(200);
    expect(
      ((await call('GET', '/api/sites')).body as unknown as any[]).map((s) => s.name),
    ).toContain('Baner Clinic');

    const pt = await newPatient();
    const booked = (
      await call('POST', '/api/jobs', pt, {
        service_id: S.services.nursing,
        starts_at: tomorrowAt('05:00'),
      })
    ).body['job'];
    const upd = await call('PUT', `/api/ops/services/${S.services.nursing}`, admin, {
      price_paise: 89900,
    });
    expect(upd.body['price_paise']).toBe(89900);
    expect((await call('GET', `/api/jobs/${booked.id}`, pt)).body['price_paise']).toBe(50000);

    const created = await call('POST', '/api/ops/services', admin, {
      name: 'Catheter care',
      kind: 'home_visit',
      skill: 'nursing',
      duration_min: 40,
      price_paise: 89900,
    });
    expect(created.status).toBe(200);
    await call('PUT', `/api/ops/services/${created.body['id']}`, admin, { active: false });
    expect(
      ((await call('GET', '/api/services')).body as unknown as any[]).map((s) => s.name),
    ).not.toContain('Catheter care');
    expect(
      (
        await call('POST', '/api/jobs', pt, {
          service_id: created.body['id'],
          starts_at: tomorrowAt('06:00'),
        })
      ).status,
    ).toBe(400);
  });
});

describe('notifications and live location', () => {
  const outbox = () =>
    db
      .prepare('SELECT template, to_phone, status, body, error FROM notifications ORDER BY rowid')
      .all() as any[];

  it('messages patient and staff through the job, with a live ETA, and pages ops on critical readings', async () => {
    const pt = await newPatient();
    const j = (
      await call('POST', '/api/jobs', pt, {
        service_id: S.services.nursing,
        starts_at: tomorrowAt('05:00'),
      })
    ).body['job'];
    await notifier.flush();
    expect(outbox().map((n) => [n.template, n.to_phone])).toEqual([
      ['booked', '9300000001'],
      ['assigned', '9300000001'],
      ['staff_assigned', '9100000001'],
    ]);
    expect(sent).toHaveLength(3);
    expect(outbox().every((n) => n.status === 'sent')).toBe(true);

    const nurse = await login('9100000001');
    // Nurse starts 3 km away; the patient sees an ETA in the app and in the message.
    await call('POST', `/api/jobs/${j.id}/actions/start`, nurse, { lat: 18.51, lng: 73.84 });
    const view = await call('GET', `/api/jobs/${j.id}`, pt);
    expect(view.body['eta_min']).toBeGreaterThan(10);
    expect(view.body['eta_min']).toBeLessThan(40);
    await notifier.flush();
    expect(outbox().at(-1).body).toMatch(/on the way, arriving in about \d+ min/);

    // Location updates move the ETA; ops sees the nurse on the live map.
    expect(
      (await call('POST', '/api/staff/location', nurse, { lat: 18.489, lng: 73.819 })).body[
        'active_trips'
      ],
    ).toBe(1);
    const closer = await call('GET', `/api/jobs/${j.id}`, pt);
    expect(closer.body['eta_min']).toBeLessThan(view.body['eta_min']);
    const ops = await login('9000000002');
    const live = await call('GET', '/api/ops/live', ops);
    expect(live.body['staff'].map((s: any) => s.name)).toContain('Nurse Near');
    expect(live.body['jobs'].find((x: any) => x.id === j.id).eta_min).toBe(closer.body['eta_min']);
    expect((await call('POST', '/api/staff/location', pt, { lat: 1, lng: 1 })).status).toBe(403);

    await call('POST', `/api/jobs/${j.id}/actions/arrive`, nurse);
    await call('POST', `/api/jobs/${j.id}/actions/begin`, nurse);
    await call('POST', `/api/jobs/${j.id}/observations`, nurse, [{ code: 'spo2', value: 86 }]);
    await notifier.flush();
    const pages = outbox().filter((n) => n.template === 'critical_alert');
    expect(pages.map((n) => n.to_phone).sort()).toEqual(['9000000001', '9000000002']);
    expect(pages[0].body).toContain('SpO₂ 86%');
    expect((await call('GET', '/api/ops/notifications', ops)).body).toHaveLength(outbox().length);
  });

  it('a failing provider never breaks the booking; failures are recorded', async () => {
    failSends = true;
    const pt = await newPatient();
    const r = await call('POST', '/api/jobs', pt, {
      service_id: S.services.nursing,
      starts_at: tomorrowAt('05:00'),
    });
    expect(r.status).toBe(200);
    await notifier.flush();
    expect(outbox().every((n) => n.status === 'failed' && n.error === 'provider down')).toBe(true);
  });

  it('reassignment tells the previous nurse; cancellation tells both sides', async () => {
    const pt = await newPatient();
    const j = (
      await call('POST', '/api/jobs', pt, {
        service_id: S.services.nursing,
        starts_at: tomorrowAt('05:00'),
      })
    ).body['job'];
    const ops = await login('9000000002');
    await call('POST', `/api/jobs/${j.id}/actions/assign`, ops, { staff_id: S.nurseFar });
    await call('POST', `/api/jobs/${j.id}/actions/cancel`, ops, {
      reason: 'patient admitted to hospital',
    });
    await notifier.flush();
    const t = outbox()
      .slice(3)
      .map((n) => [n.template, n.to_phone]);
    expect(t).toEqual([
      ['assigned', '9300000001'],
      ['staff_assigned', '9100000002'],
      ['staff_unassigned', '9100000001'],
      ['cancelled', '9300000001'],
      ['staff_cancelled', '9100000002'],
    ]);
  });
});

describe('recurring care plans', () => {
  const localDay = (offsetDays: number) =>
    new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const planBody = (extra: Record<string, unknown> = {}) => ({
    service_id: S.services.nursing,
    rule: 'FREQ=DAILY',
    start_date: localDay(1),
    time_of_day: '09:00',
    ...extra,
  });
  const jobsOf = (planId: string) =>
    db.prepare('SELECT * FROM jobs WHERE plan_id = ? ORDER BY plan_date').all(planId) as Record<
      string,
      any
    >[];

  it('generates two weeks of visits, dispatches the first, and is idempotent', async () => {
    const patient = await newPatient();
    const r = await call('POST', '/api/care-plans', patient, planBody());
    expect(r.status).toBe(200);
    const planId = r.body['plan']['id'] as string;
    expect(r.body['generated']['created']).toHaveLength(14);

    const jobs = jobsOf(planId);
    expect(jobs).toHaveLength(14);
    expect(jobs[0]!['plan_date']).toBe(localDay(1));
    expect(jobs[0]!['starts_at']).toBe(`${localDay(1)}T03:30:00.000Z`); // 09:00 IST
    expect(jobs[0]!['status']).toBe('assigned'); // staff only have shifts tomorrow
    expect(jobs[1]!['status']).toBe('requested'); // waits in the ops queue

    const again = await call('POST', '/api/ops/care-plans/generate', await login('9000000002'));
    expect(again.body['created']).toBe(0);
    expect(jobsOf(planId)).toHaveLength(14);

    const list = await call('GET', '/api/care-plans', patient);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]['upcoming'][0]['date']).toBe(localDay(1));
    expect(list.body[0]['upcoming'][0]['job']['status']).toBe('assigned');
  });

  it('weekly plans only book the chosen weekdays', async () => {
    const patient = await newPatient();
    const r = await call(
      'POST',
      '/api/care-plans',
      patient,
      planBody({ rule: 'FREQ=WEEKLY;BYDAY=MO,TH', start_date: localDay(0) }),
    );
    const dates = jobsOf(r.body['plan']['id']).map((j) => j['plan_date'] as string);
    expect(dates.length).toBeGreaterThanOrEqual(4);
    expect(dates.length).toBeLessThanOrEqual(5);
    for (const d of dates) expect([1, 4]).toContain(new Date(`${d}T00:00:00Z`).getUTCDay());
  });

  it('skips one occurrence without disturbing the rest, and can restore it', async () => {
    const patient = await newPatient();
    const planId = (await call('POST', '/api/care-plans', patient, planBody())).body['plan']['id'];
    const day = localDay(1);
    const skip = await call('POST', `/api/care-plans/${planId}/occurrences/${day}`, patient, {
      action: 'skip',
    });
    expect(skip.status).toBe(200);
    expect(skip.body['upcoming'][0]['skipped']).toBe(true);
    const first = jobsOf(planId)[0]!;
    expect(first['status']).toBe('cancelled');
    expect(first['cancel_reason']).toBe('skipped from care plan');
    expect(jobsOf(planId).filter((j) => j['status'] !== 'cancelled')).toHaveLength(13);
    // The patient and the assigned nurse were told.
    const told = db
      .prepare("SELECT template FROM notifications WHERE job_id = ? AND template LIKE '%cancel%'")
      .all(first['id']);
    expect(told.length).toBeGreaterThanOrEqual(1);

    // Generation never resurrects a skipped visit.
    await call('POST', '/api/ops/care-plans/generate', await login('9000000002'));
    expect(jobsOf(planId).filter((j) => j['plan_date'] === day)).toHaveLength(1);

    const back = await call('POST', `/api/care-plans/${planId}/occurrences/${day}`, patient, {
      action: 'restore',
    });
    expect(back.status).toBe(200);
    const live = jobsOf(planId).filter(
      (j) => j['plan_date'] === day && j['status'] !== 'cancelled',
    );
    expect(live).toHaveLength(1);
    expect(live[0]!['status']).toBe('assigned');
  });

  it('modifies one occurrence: new time, rebooked and re-dispatched', async () => {
    const patient = await newPatient();
    const planId = (await call('POST', '/api/care-plans', patient, planBody())).body['plan']['id'];
    const day = localDay(1);
    const r = await call('POST', `/api/care-plans/${planId}/occurrences/${day}`, patient, {
      action: 'modify',
      time_of_day: '11:30',
      notes: 'please call at the gate',
    });
    expect(r.status).toBe(200);
    expect(r.body['upcoming'][0]['modified']).toBe(true);
    expect(r.body['upcoming'][0]['starts_at']).toBe(`${day}T06:00:00.000Z`);
    const live = jobsOf(planId).filter((j) => j['status'] !== 'cancelled');
    expect(live).toHaveLength(14);
    const moved = live.find((j) => j['plan_date'] === day)!;
    expect(moved['starts_at']).toBe(`${day}T06:00:00.000Z`);
    expect(moved['notes']).toBe('please call at the gate');
    expect(moved['status']).toBe('assigned');
    // Other days keep the plan's usual time and notes.
    expect(live[1]!['starts_at'].slice(11, 16)).toBe('03:30');
  });

  it('refuses to change a visit that has already started', async () => {
    const patient = await newPatient();
    const planId = (await call('POST', '/api/care-plans', patient, planBody())).body['plan']['id'];
    db.prepare("UPDATE jobs SET status = 'en_route' WHERE plan_id = ? AND plan_date = ?").run(
      planId,
      localDay(1),
    );
    const r = await call('POST', `/api/care-plans/${planId}/occurrences/${localDay(1)}`, patient, {
      action: 'skip',
    });
    expect(r.status).toBe(409);
  });

  it('rejects dates that are not part of the plan', async () => {
    const patient = await newPatient();
    const planId = (
      await call('POST', '/api/care-plans', patient, planBody({ rule: 'FREQ=WEEKLY' }))
    ).body['plan']['id'];
    const off = localDay(2);
    const r = await call('POST', `/api/care-plans/${planId}/occurrences/${off}`, patient, {
      action: 'skip',
    });
    expect(r.status).toBe(404);
  });

  it('ending a plan cancels its upcoming visits and stops generation', async () => {
    const patient = await newPatient();
    const planId = (await call('POST', '/api/care-plans', patient, planBody())).body['plan']['id'];
    const r = await call('POST', `/api/care-plans/${planId}/end`, patient);
    expect(r.status).toBe(200);
    expect(r.body['cancelled_jobs']).toBe(14);
    expect(jobsOf(planId).every((j) => j['status'] === 'cancelled')).toBe(true);
    await call('POST', '/api/ops/care-plans/generate', await login('9000000002'));
    expect(jobsOf(planId)).toHaveLength(14);
  });

  it('validates the rule and the service, and enforces ownership', async () => {
    const patient = await newPatient();
    const bad = await call('POST', '/api/care-plans', patient, planBody({ rule: 'FREQ=YEARLY' }));
    expect(bad.status).toBe(400);
    const del = await call(
      'POST',
      '/api/care-plans',
      patient,
      planBody({ service_id: S.services.delivery }),
    );
    expect(del.status).toBe(400);
    const planId = (await call('POST', '/api/care-plans', patient, planBody())).body['plan']['id'];

    const other = await call('POST', '/api/auth/register', undefined, {
      name: 'Other',
      phone: '9300000002',
      password: PW,
      consent: true,
    });
    const stranger = other.body['token'] as string;
    expect((await call('POST', `/api/care-plans/${planId}/end`, stranger)).status).toBe(404);
    expect((await call('GET', '/api/care-plans', stranger)).body).toHaveLength(0);
    expect((await call('GET', '/api/care-plans', await login('9100000001'))).status).toBe(403);
  });

  it('ops can set up a plan for a patient by phone', async () => {
    const patient = await newPatient();
    const me = await call('GET', '/api/me', patient);
    const r = await call(
      'POST',
      '/api/care-plans',
      await login('9000000002'),
      planBody({ patient_id: me.body['id'] ?? me.body['user']?.['id'] }),
    );
    expect(r.status).toBe(200);
    expect((await call('GET', '/api/care-plans', patient)).body).toHaveLength(1);
  });

  it('a patient without an address gets a clear failure, recorded per date', async () => {
    const r = await call('POST', '/api/auth/register', undefined, {
      name: 'NoAddr',
      phone: '9300000003',
      password: PW,
      consent: true,
    });
    const res = await call('POST', '/api/care-plans', r.body['token'], planBody());
    expect(res.status).toBe(200);
    expect(res.body['generated']['created']).toHaveLength(0);
    expect(res.body['generated']['failed'][0]['reason']).toMatch(/address/);
  });
});
