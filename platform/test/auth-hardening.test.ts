/** Login lockout, OTP password reset and session revocation through the HTTP layer. */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { id, openDb, type DB } from '../src/db.js';
import { Notifier } from '../src/notify.js';
import { RateLimiter } from '../src/ratelimit.js';

let db: DB;
let app: ReturnType<typeof buildApp>;
let sent: { to: string; body: string }[];
let notifier: Notifier;
const PW = 'password123';

beforeEach(() => {
  db = openDb(':memory:');
  sent = [];
  notifier = new Notifier(db, {
    name: 'fake',
    send: async (to, body) => {
      sent.push({ to, body });
      return { ref: 'x' };
    },
  });
  app = buildApp({ db, secret: 's', notifier });
  for (const [role, phone] of [
    ['admin', '9000000001'],
    ['patient', '9300000001'],
  ] as const)
    db.prepare(
      'INSERT INTO users (id, role, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id('usr'), role, role, phone, hashPassword(PW), new Date().toISOString());
});

async function call(method: 'GET' | 'POST', url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any>, headers: res.headers };
}
const login = (phone: string, password = PW) =>
  call('POST', '/api/auth/login', undefined, { phone, password });
const codeSent = async () => {
  await notifier.flush();
  const m = sent.at(-1)?.body.match(/code is (\d{6})/);
  return m![1]!;
};

describe('login lockout', () => {
  it('locks a phone after 5 failures, even for the right password, with Retry-After', async () => {
    for (let i = 0; i < 5; i++) expect((await login('9300000001', 'wrong-pass')).status).toBe(401);
    const r = await login('9300000001');
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // Other accounts are unaffected.
    expect((await login('9000000001')).status).toBe(200);
  });

  it('a successful login clears the failure count', async () => {
    for (let i = 0; i < 4; i++) await login('9300000001', 'wrong-pass');
    expect((await login('9300000001')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('9300000001', 'wrong-pass')).status).toBe(401);
  });

  it('limits one address across many phones', async () => {
    app = buildApp({
      db,
      secret: 's',
      notifier,
      limiters: { loginIp: new RateLimiter(3, 60_000) },
    });
    for (let i = 0; i < 3; i++) await login(`90000000${i}9`, 'x');
    expect((await login('9300000001')).status).toBe(429);
  });

  it('limits registrations per address', async () => {
    app = buildApp({
      db,
      secret: 's',
      notifier,
      limiters: { register: new RateLimiter(2, 60_000) },
    });
    const reg = (n: number) =>
      call('POST', '/api/auth/register', undefined, {
        name: 'Test User',
        phone: `97000000${n}0`,
        password: PW,
        consent: true,
      });
    expect((await reg(1)).status).toBe(200);
    expect((await reg(2)).status).toBe(200);
    expect((await reg(3)).status).toBe(429);
  });
});

describe('password reset by OTP', () => {
  const request = (phone: string) => call('POST', '/api/auth/reset/request', undefined, { phone });
  const confirm = (phone: string, code: string, password = 'brand-new-pass') =>
    call('POST', '/api/auth/reset/confirm', undefined, { phone, code, password });

  it('resets the password, sends the code, ends old sessions and is single use', async () => {
    const old = (await login('9300000001')).body['token'];
    expect((await request('9300000001')).status).toBe(200);
    const code = await codeSent();
    const r = await confirm('9300000001', code);
    expect(r.status).toBe(200);
    expect(r.body['token']).toBeTruthy();
    expect((await login('9300000001')).status).toBe(401); // old password
    expect((await login('9300000001', 'brand-new-pass')).status).toBe(200);
    expect((await call('GET', '/api/me', old)).status).toBe(401); // old session revoked
    expect((await call('GET', '/api/me', r.body['token'])).status).toBe(200);
    expect((await confirm('9300000001', code, 'another-pass-1')).status).toBe(400); // reused
  });

  it('answers identically for unknown numbers and sends nothing', async () => {
    const known = await request('9300000001');
    const unknown = await request('9111111111');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await notifier.flush();
    expect(sent).toHaveLength(1);
  });

  it('never stores the code in the notification outbox or the database in clear', async () => {
    await request('9300000001');
    const code = await codeSent();
    const outbox = db.prepare('SELECT body FROM notifications').all() as { body: string }[];
    expect(outbox.some((o) => o.body.includes(code))).toBe(false);
    const row = db.prepare('SELECT code_hash FROM password_resets').get() as { code_hash: string };
    expect(row.code_hash).not.toContain(code);
  });

  it('burns the code after 5 wrong guesses', async () => {
    await request('9300000001');
    const code = await codeSent();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await confirm('9300000001', wrong)).status).toBe(400);
    expect((await confirm('9300000001', code)).status).toBe(400);
    expect((await login('9300000001')).status).toBe(200); // password unchanged
  });

  it('rejects expired codes and a newer request supersedes the older code', async () => {
    await request('9300000001');
    const first = await codeSent();
    await request('9300000001');
    const second = await codeSent();
    if (first !== second) expect((await confirm('9300000001', first)).status).toBe(400);
    db.prepare("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await confirm('9300000001', second)).status).toBe(400);
  });

  it('rate limits requests per phone and validates the new password', async () => {
    for (let i = 0; i < 3; i++) expect((await request('9300000001')).status).toBe(200);
    expect((await request('9300000001')).status).toBe(429);
    expect((await confirm('9300000001', '123456', 'short')).status).toBe(400);
  });

  it('does not reset disabled accounts', async () => {
    db.prepare("UPDATE users SET active = 0 WHERE phone = '9300000001'").run();
    await request('9300000001');
    await notifier.flush();
    expect(sent).toHaveLength(0);
  });
});

describe('session revocation', () => {
  it('logout-all ends all other sessions and returns a working token', async () => {
    const a = (await login('9300000001')).body['token'];
    const b = (await login('9300000001')).body['token'];
    const r = await call('POST', '/api/auth/logout-all', a);
    expect(r.status).toBe(200);
    expect((await call('GET', '/api/me', a)).status).toBe(401);
    expect((await call('GET', '/api/me', b)).status).toBe(401);
    expect((await call('GET', '/api/me', r.body['token'])).status).toBe(200);
  });

  it('an admin can revoke another user; others cannot', async () => {
    const admin = (await login('9000000001')).body['token'];
    const patient = (await login('9300000001')).body['token'];
    const pid = (await call('GET', '/api/me', patient)).body['id'];
    expect((await call('POST', `/api/ops/users/${pid}/revoke-sessions`, patient)).status).toBe(403);
    expect((await call('POST', `/api/ops/users/${pid}/revoke-sessions`, admin)).status).toBe(200);
    expect((await call('GET', '/api/me', patient)).status).toBe(401);
    expect((await call('GET', '/api/me', admin)).status).toBe(200);
    expect((await call('POST', '/api/ops/users/nope/revoke-sessions', admin)).status).toBe(404);
  });
});
