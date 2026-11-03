/** Payment links, signed webhooks and PDF documents through the real HTTP layer. */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { id, openDb, type DB } from '../src/db.js';
import { Notifier } from '../src/notify.js';
import { fakePaymentProvider, signWebhook } from '../src/payments.js';

const SECRET = 'whsec_test';
let db: DB;
let app: ReturnType<typeof buildApp>;
let fake: ReturnType<typeof fakePaymentProvider>;
let svc: string;

beforeEach(() => {
  db = openDb(':memory:');
  fake = fakePaymentProvider();
  app = buildApp({
    db,
    secret: 's',
    notifier: new Notifier(db, { name: 'log', send: async () => ({ ref: 'x' }) }),
    payments: fake,
    webhookSecret: SECRET,
  });
  svc = id('svc');
  db.prepare(
    "INSERT INTO services (id, name, kind, skill, duration_min, price_paise) VALUES (?, 'Nursing', 'home_visit', 'nursing', 45, 123456)",
  ).run(svc);
  for (const [role, phone] of [
    ['admin', '9000000001'],
    ['patient', '9300000001'],
    ['patient', '9300000002'],
  ] as const)
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
});

const tok = async (phone: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { phone, password: 'password123' },
    })
  ).json().token as string;
function job(patient = 'u_9300000001', status = 'requested') {
  const jid = id('job');
  db.prepare(
    `INSERT INTO jobs (id, patient_id, service_id, kind, status, starts_at, ends_at, address, price_paise, created_at, updated_at)
     VALUES (?, ?, ?, 'home_visit', ?, '2026-11-10T05:00:00.000Z', '2026-11-10T05:45:00.000Z', 'Pune', 123456, ?, ?)`,
  ).run(jid, patient, svc, status, new Date().toISOString(), new Date().toISOString());
  return jid;
}
const link = async (t: string, jid: string) =>
  app.inject({
    method: 'POST',
    url: `/api/jobs/${jid}/payment-link`,
    headers: { authorization: `Bearer ${t}` },
  });
function hook(
  jid: string,
  linkRef: string,
  over: { amount?: number; ref?: string; sig?: string } = {},
) {
  const raw = JSON.stringify({
    event: 'payment_link.paid',
    payload: {
      payment_link: {
        entity: { id: linkRef, reference_id: over.ref ?? jid, amount: over.amount ?? 123456 },
      },
      payment: { entity: { id: 'pay_1', method: 'upi' } },
    },
  });
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': over.sig ?? signWebhook(raw, SECRET),
      'x-razorpay-event-id': 'evt_1',
    },
    payload: raw,
  });
}

describe('payment links', () => {
  it('creates a link for the owner at the booked price and reuses it', async () => {
    const t = await tok('9300000001');
    const jid = job();
    const a = await link(t, jid);
    expect(a.statusCode).toBe(200);
    expect(a.json().url).toContain('pay.example.test');
    expect(fake.created[0]).toMatchObject({ amountPaise: 123456, reference: jid });
    const b = await link(t, jid);
    expect(b.json()).toMatchObject({ url: a.json().url, reused: true });
    expect(fake.created).toHaveLength(1);
  });
  it("hides other patients' visits, refuses settled/cancelled ones, and 501s without a provider", async () => {
    expect((await link(await tok('9300000002'), job())).statusCode).toBe(404);
    const t = await tok('9300000001');
    db.prepare("UPDATE jobs SET payment_status = 'paid'").run();
    expect((await link(t, job())).statusCode).toBe(200);
    const paid = job();
    db.prepare("UPDATE jobs SET payment_status = 'paid' WHERE id = ?").run(paid);
    expect((await link(t, paid)).statusCode).toBe(409);
    const gone = job('u_9300000001', 'cancelled');
    expect((await link(t, gone)).statusCode).toBe(409);
    const bare = buildApp({ db, secret: 's', payments: null });
    const bt = (
      await bare.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { phone: '9300000001', password: 'password123' },
      })
    ).json().token;
    expect(
      (
        await bare.inject({
          method: 'POST',
          url: `/api/jobs/${job()}/payment-link`,
          headers: { authorization: `Bearer ${bt}` },
        })
      ).statusCode,
    ).toBe(501);
  });
});

describe('webhook', () => {
  it('marks the visit paid on a correctly signed event, once', async () => {
    const t = await tok('9300000001');
    const jid = job();
    const ref = (await link(t, jid)).json().url.split('/').pop();
    const r = await hook(jid, ref);
    expect(r.statusCode).toBe(200);
    const j = db.prepare('SELECT payment_status, payment_method FROM jobs WHERE id = ?').get(jid);
    expect(j).toEqual({ payment_status: 'paid', payment_method: 'upi' });
    expect((await hook(jid, ref)).json().duplicate).toBe(true);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'payment_received'").get(),
    ).toEqual({ n: 1 });
  });
  it('rejects bad signatures and leaves the visit unpaid', async () => {
    const jid = job();
    const ref = (await link(await tok('9300000001'), jid)).json().url.split('/').pop();
    expect((await hook(jid, ref, { sig: 'deadbeef' })).statusCode).toBe(401);
    expect(db.prepare('SELECT payment_status FROM jobs WHERE id = ?').get(jid)).toEqual({
      payment_status: 'unpaid',
    });
  });
  it('rejects an amount or reference that does not match the link', async () => {
    const jid = job();
    const ref = (await link(await tok('9300000001'), jid)).json().url.split('/').pop();
    expect((await hook(jid, ref, { amount: 100 })).statusCode).toBe(422);
    expect((await hook(jid, ref, { ref: 'job_other' })).statusCode).toBe(422);
    expect(db.prepare('SELECT payment_status FROM jobs WHERE id = ?').get(jid)).toEqual({
      payment_status: 'unpaid',
    });
  });
  it('acknowledges unknown links and other events without changing anything', async () => {
    expect((await hook('j', 'plink_unknown')).json().ignored).toBe(true);
  });
  it('is refused outright when no webhook secret is configured', async () => {
    const open = buildApp({ db, secret: 's', payments: fake, webhookSecret: '' });
    const raw = '{"event":"payment_link.paid"}';
    const r = await open.inject({
      method: 'POST',
      url: '/api/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signWebhook(raw, '') },
      payload: raw,
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('documents', () => {
  it('serves an invoice before payment and a receipt after, to the owner only', async () => {
    const t = await tok('9300000001');
    const jid = job();
    const get = (token: string) =>
      app.inject({
        method: 'GET',
        url: `/api/jobs/${jid}/invoice.pdf`,
        headers: { authorization: `Bearer ${token}` },
      });
    const inv = await get(t);
    expect(inv.statusCode).toBe(200);
    expect(inv.headers['content-type']).toBe('application/pdf');
    expect(inv.rawPayload.toString('latin1')).toContain('(Invoice)');
    expect(inv.rawPayload.toString('latin1')).toContain('Rs 1,234.56');
    const ref = (await link(t, jid)).json().url.split('/').pop();
    await hook(jid, ref);
    const rec = (await get(t)).rawPayload.toString('latin1');
    expect(rec).toContain('(Payment receipt)');
    expect(rec).toContain('RCT-');
    expect((await get(await tok('9300000002'))).statusCode).toBe(404);
    expect((await get(await tok('9000000001'))).statusCode).toBe(200);
  });
});
