import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomInt } from 'node:crypto';
import { z, ZodError } from 'zod';
import { hashPassword, signToken, verifyPassword, verifyToken, type Claims } from './auth.js';
import { audit, id, now, type DB } from './db.js';
import { rank, travelMinutes, type Candidate, type JobRequest } from './domain/dispatch.js';
import { messagesFor, Notifier, providerFromEnv, type JobEvent } from './notify.js';
import {
  isOpen,
  transition,
  TransitionError,
  type Action,
  type JobKind,
  type JobStatus,
  type Role,
} from './domain/jobs.js';
import {
  invoicePdf,
  parsePaidEvent,
  paymentProviderFromEnv,
  verifyWebhookSignature,
  type PaymentProvider,
} from './payments.js';
import { localDate, localToUtc, occurrences, parseRule, RuleError } from './domain/recurrence.js';
import { assess, validateReading, VITALS, type VitalCode } from './domain/vitals.js';

export interface AppOptions {
  db: DB;
  secret: string;
  corsOrigin?: string | boolean;
  /** Built web app to serve at / (optional; the API works without it). */
  publicDir?: string;
  /** Outbound messages; defaults to the provider configured in the environment. */
  notifier?: Notifier;
  /** Online payment links; defaults to Razorpay when its keys are set, otherwise none. */
  payments?: PaymentProvider | null;
  /** Razorpay webhook secret; webhooks are rejected without it. */
  webhookSecret?: string;
}

type Row = Record<string, unknown>;

declare module 'fastify' {
  interface FastifyRequest {
    user?: Claims;
  }
}

/** In-process event bus for live updates (SSE). */
type Listener = (event: { type: string; data: unknown }) => void;

export function buildApp({
  db,
  secret,
  corsOrigin = true,
  publicDir,
  notifier: given,
  payments: givenPayments,
  webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET'] ?? '',
}: AppOptions) {
  const payments = givenPayments === undefined ? paymentProviderFromEnv() : givenPayments;
  const notifier = given ?? new Notifier(db, providerFromEnv());
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  void app.register(cors, { origin: corsOrigin });
  // Webhook signatures cover the exact bytes received, so keep the raw body next to the parsed one.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined);
    }
  });
  const listeners = new Map<Listener, Claims>();

  const publish = (type: string, data: { patient_id?: string; staff_id?: string | null } & Row) => {
    for (const [fn, who] of listeners) {
      const ops = who.role === 'ops' || who.role === 'admin';
      if (ops || who.sub === data.patient_id || who.sub === data.staff_id) fn({ type, data });
    }
  };

  /** Staff position if reported recently enough to be useful for an ETA. */
  const freshLocation = (staffId: unknown, maxAgeMin = 10) => {
    if (!staffId) return null;
    const l = db
      .prepare('SELECT lat, lng, at FROM staff_locations WHERE staff_id = ?')
      .get(staffId) as Row | undefined;
    if (!l || Date.now() - Date.parse(String(l['at'])) > maxAgeMin * 60_000) return null;
    return { lat: Number(l['lat']), lng: Number(l['lng']), at: String(l['at']) };
  };
  const etaFor = (j: Row) => {
    const loc = j['status'] === 'en_route' ? freshLocation(j['staff_id']) : null;
    if (!loc || j['lat'] == null) return null;
    return {
      eta_min: travelMinutes(loc, { lat: Number(j['lat']), lng: Number(j['lng']) }),
      staff_location_at: loc.at,
    };
  };
  const userBrief = (uid: unknown) =>
    uid
      ? ((db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(uid) as
          Row | undefined) ?? null)
      : null;

  /** Turn a job event into messages for the patient and staff involved. */
  const notifyJob = (event: JobEvent, jobId: string, previousStaffId?: string | null) => {
    const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Row;
    const svc = db.prepare('SELECT name FROM services WHERE id = ?').get(j['service_id']) as Row;
    notifier.enqueue(
      messagesFor(event, j, {
        service: String(svc['name']),
        patient: userBrief(j['patient_id'])!,
        staff: userBrief(j['staff_id'] ?? previousStaffId),
        previousStaff: userBrief(previousStaffId),
        etaMin: etaFor(j)?.eta_min ?? null,
      }),
      { jobId },
    );
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return reply.status(400).send({
        error: 'invalid input',
        issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    if (err instanceof TransitionError)
      return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) console.error(err);
    return reply
      .status(status)
      .send({ error: status >= 500 ? 'internal error' : (err as Error).message });
  });

  // ---------- auth ----------
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const q = (req.query as Row | undefined)?.['token'];
    const token = h?.startsWith('Bearer ') ? h.slice(7) : typeof q === 'string' ? q : null;
    const claims = token ? verifyToken(token, secret) : null;
    if (!claims) return reply.status(401).send({ error: 'sign in required' });
    const u = db.prepare('SELECT active, role FROM users WHERE id = ?').get(claims.sub) as
      Row | undefined;
    if (!u || !u['active']) return reply.status(401).send({ error: 'account disabled' });
    req.user = claims;
  };
  const roles =
    (...allowed: Role[]) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      await authenticate(req, reply);
      if (reply.sent) return;
      if (!allowed.includes(req.user!.role))
        return reply.status(403).send({ error: 'not allowed for your role' });
    };
  const anyone = roles('patient', 'caregiver', 'courier', 'ops', 'admin');
  const OPS: Role[] = ['ops', 'admin'];
  const STAFF: Role[] = ['caregiver', 'courier'];

  const Phone = z.string().regex(/^\+?[0-9]{10,15}$/, 'phone must be 10–15 digits');
  const Password = z.string().min(8, 'at least 8 characters');

  const publicUser = (u: Row) => ({
    id: u['id'],
    role: u['role'],
    name: u['name'],
    phone: u['phone'],
    email: u['email'],
  });

  app.post('/api/auth/register', async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(2),
        phone: Phone,
        password: Password,
        email: z.string().email().optional(),
        consent: z.literal(true),
      })
      .parse(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(b.phone))
      throw httpError(409, 'that phone number is already registered');
    const uid = id('usr');
    const t = now();
    db.transaction(() => {
      db.prepare(
        'INSERT INTO users (id, role, name, phone, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(uid, 'patient', b.name, b.phone, b.email ?? null, hashPassword(b.password), t);
      db.prepare('INSERT INTO patients (user_id, consent_at) VALUES (?, ?)').run(uid, t);
      audit(db, uid, 'register', 'user', uid);
    })();
    return {
      token: signToken({ sub: uid, role: 'patient' }, secret),
      user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Row),
    };
  });

  app.post('/api/auth/login', async (req) => {
    const b = z.object({ phone: z.string(), password: z.string() }).parse(req.body);
    const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(b.phone) as Row | undefined;
    if (!u || !u['active'] || !verifyPassword(b.password, String(u['password_hash']))) {
      audit(db, null, 'login_failed', 'user', null, { phone: b.phone });
      throw httpError(401, 'wrong phone number or password');
    }
    audit(db, String(u['id']), 'login', 'user', String(u['id']));
    return {
      token: signToken({ sub: String(u['id']), role: u['role'] as Role }, secret),
      user: publicUser(u),
    };
  });

  app.get('/api/me', { preHandler: anyone }, async (req) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.sub) as Row;
    return publicUser(u);
  });

  // ---------- catalog ----------
  app.get('/api/services', async () =>
    db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY kind, name').all(),
  );
  app.get('/api/sites', async () => db.prepare('SELECT * FROM sites ORDER BY name').all());

  // ---------- patient profile ----------
  const Profile = z.object({
    date_of_birth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    sex: z.enum(['female', 'male', 'other']).optional(),
    conditions: z.array(z.string().max(60)).max(20).optional(),
    allergies: z.array(z.string().max(60)).max(30).optional(),
    address: z.string().max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    emergency_name: z.string().max(80).optional(),
    emergency_phone: Phone.optional(),
  });
  const readProfile = (uid: string) => {
    const p = db
      .prepare(
        'SELECT p.*, u.name, u.phone FROM patients p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?',
      )
      .get(uid) as Row | undefined;
    if (!p) throw httpError(404, 'patient not found');
    return {
      ...p,
      conditions: JSON.parse(String(p['conditions'])),
      allergies: JSON.parse(String(p['allergies'])),
    };
  };
  app.get('/api/patient/profile', { preHandler: roles('patient') }, async (req) =>
    readProfile(req.user!.sub),
  );
  app.put('/api/patient/profile', { preHandler: roles('patient') }, async (req) => {
    const b = Profile.parse(req.body);
    const cur = readProfile(req.user!.sub) as Row;
    const next = { ...cur, ...b };
    db.prepare(
      `UPDATE patients SET date_of_birth=?, sex=?, conditions=?, allergies=?, address=?, lat=?, lng=?, emergency_name=?, emergency_phone=? WHERE user_id=?`,
    ).run(
      next['date_of_birth'] ?? null,
      next['sex'] ?? null,
      JSON.stringify(next['conditions'] ?? []),
      JSON.stringify(next['allergies'] ?? []),
      next['address'] ?? '',
      next['lat'] ?? null,
      next['lng'] ?? null,
      next['emergency_name'] ?? null,
      next['emergency_phone'] ?? null,
      req.user!.sub,
    );
    audit(db, req.user!.sub, 'update_profile', 'patient', req.user!.sub, Object.keys(b));
    return readProfile(req.user!.sub);
  });

  // ---------- jobs ----------
  const getJob = (jobId: string) => {
    const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Row | undefined;
    if (!j) throw httpError(404, 'job not found');
    return j;
  };
  /** Role-scoped view: staff see need-to-know patient data; only the patient sees the delivery OTP. */
  const viewJob = (j: Row, who: Claims, detail = false) => {
    const service = db
      .prepare('SELECT name, kind, duration_min FROM services WHERE id = ?')
      .get(j['service_id']) as Row;
    const patient = db
      .prepare(
        'SELECT u.name, u.phone, p.conditions, p.allergies, p.emergency_name, p.emergency_phone FROM users u JOIN patients p ON p.user_id = u.id WHERE u.id = ?',
      )
      .get(j['patient_id']) as Row;
    const staff = j['staff_id']
      ? (db.prepare('SELECT name, phone, role FROM users WHERE id = ?').get(j['staff_id']) as Row)
      : null;
    const site = j['site_id']
      ? (db.prepare('SELECT name, address FROM sites WHERE id = ?').get(j['site_id']) as Row)
      : null;
    const isPatient = who.role === 'patient';
    const out: Row = {
      ...j,
      items: JSON.parse(String(j['items'])),
      service,
      site,
      otp_code: isPatient ? j['otp_code'] : undefined,
      ...(etaFor(j) ?? {}),
      staff: staff ? { name: staff['name'], phone: staff['phone'], role: staff['role'] } : null,
      patient: isPatient
        ? undefined
        : {
            name: patient['name'],
            phone: patient['phone'],
            conditions: JSON.parse(String(patient['conditions'])),
            allergies: JSON.parse(String(patient['allergies'])),
            emergency_name: patient['emergency_name'],
            emergency_phone: patient['emergency_phone'],
          },
    };
    if (detail) {
      out['events'] = db
        .prepare(
          'SELECT status, at, note, (SELECT name FROM users WHERE id = by_user) AS by FROM job_events WHERE job_id = ? ORDER BY id',
        )
        .all(j['id']);
      out['observations'] = db
        .prepare('SELECT * FROM observations WHERE job_id = ? ORDER BY recorded_at')
        .all(j['id']);
    }
    return out;
  };
  const canSee = (j: Row, who: Claims) =>
    OPS.includes(who.role) || j['patient_id'] === who.sub || j['staff_id'] === who.sub;

  const JobInput = z.object({
    service_id: z.string(),
    starts_at: z.string().datetime({ offset: true }),
    notes: z.string().max(1000).default(''),
    site_id: z.string().optional(),
    items: z
      .array(z.object({ name: z.string().min(1).max(120), qty: z.number().int().min(1).max(100) }))
      .max(30)
      .default([]),
    patient_id: z.string().optional(), // ops booking on behalf of a patient (phone bookings)
  });

  type JobIn = z.infer<typeof JobInput>;
  /** Validate, insert, auto-dispatch and notify. Shared by bookings and care-plan generation. */
  const createJob = (
    b: Omit<JobIn, 'patient_id'>,
    patientId: string,
    actor: string,
    plan?: { id: string; date: string },
  ) => {
    const svc = db
      .prepare('SELECT * FROM services WHERE id = ? AND active = 1')
      .get(b.service_id) as Row | undefined;
    if (!svc) throw httpError(400, 'unknown service');
    const kind = svc['kind'] as JobKind;
    const start = new Date(b.starts_at);
    if (start.getTime() < Date.now() - 5 * 60_000)
      throw httpError(400, 'pick a time in the future');
    const end = new Date(start.getTime() + Number(svc['duration_min']) * 60_000);
    const p = readProfile(patientId) as Row;
    let address = String(p['address'] ?? '');
    let lat = p['lat'] as number | null;
    let lng = p['lng'] as number | null;
    let siteId: string | null = null;
    if (kind === 'clinic_visit') {
      const site = db
        .prepare("SELECT * FROM sites WHERE id = ? AND kind = 'clinic'")
        .get(b.site_id ?? '') as Row | undefined;
      if (!site) throw httpError(400, 'choose a clinic');
      siteId = String(site['id']);
      address = String(site['address']);
      lat = site['lat'] as number;
      lng = site['lng'] as number;
    } else if (!address || lat == null || lng == null) {
      throw httpError(400, 'add your home address and location to your profile first');
    }
    if (kind === 'delivery' && !b.items.length) throw httpError(400, 'list the items to deliver');
    const jid = id('job');
    const t = now();
    const otp = kind === 'delivery' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs (id, patient_id, service_id, kind, status, starts_at, ends_at, address, lat, lng, site_id, notes, items, otp_code, price_paise, created_at, updated_at, plan_id, plan_date)
         VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jid,
        patientId,
        svc['id'],
        kind,
        start.toISOString(),
        end.toISOString(),
        address,
        lat,
        lng,
        siteId,
        b.notes,
        JSON.stringify(b.items),
        otp,
        svc['price_paise'],
        t,
        t,
        plan?.id ?? null,
        plan?.date ?? null,
      );
      db.prepare('INSERT INTO job_events (job_id, status, by_user, at) VALUES (?, ?, ?, ?)').run(
        jid,
        'requested',
        actor,
        t,
      );
      audit(db, actor, 'create', 'job', jid, {
        service: svc['id'],
        starts_at: start.toISOString(),
        ...(plan ? { plan: plan.id, plan_date: plan.date } : {}),
      });
    })();
    // Try to staff it straight away; it stays in the ops queue if nobody fits.
    const auto = autoAssign(jid, actor);
    notifyJob('booked', jid);
    if (auto.assigned) notifyJob('assigned', jid);
    const j = getJob(jid);
    publish('job', { ...j, patient_id: patientId });
    return { jid, job: j, dispatch: auto };
  };

  app.post('/api/jobs', { preHandler: roles('patient', 'ops', 'admin') }, async (req) => {
    const b = JobInput.parse(req.body);
    const who = req.user!;
    const patientId = who.role === 'patient' ? who.sub : b.patient_id;
    if (!patientId) throw httpError(400, 'patient_id is required when booking for someone');
    const { job, dispatch } = createJob(b, patientId, who.sub);
    return { job: viewJob(job, who, true), dispatch };
  });

  app.get('/api/jobs', { preHandler: anyone }, async (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    const who = req.user!;
    const where: string[] = [];
    const args: unknown[] = [];
    if (who.role === 'patient') (where.push('patient_id = ?'), args.push(who.sub));
    else if (STAFF.includes(who.role)) (where.push('staff_id = ?'), args.push(who.sub));
    if (q.status)
      (where.push(
        `status IN (${q.status
          .split(',')
          .map(() => '?')
          .join(',')})`,
      ),
        args.push(...q.status.split(',')));
    if (q.date) (where.push('substr(starts_at, 1, 10) = ?'), args.push(q.date));
    const rows = db
      .prepare(
        `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY starts_at LIMIT ?`,
      )
      .all(...args, q.limit) as Row[];
    return rows.map((r) => viewJob(r, who));
  });

  app.get('/api/jobs/:id', { preHandler: anyone }, async (req) => {
    const j = getJob((req.params as Row)['id'] as string);
    if (!canSee(j, req.user!)) throw httpError(404, 'job not found');
    return viewJob(j, req.user!, true);
  });

  const ActionBody = z.object({
    staff_id: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    note: z.string().max(500).optional(),
    reason: z.string().max(300).optional(),
    otp: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    visit_notes: z.string().max(4000).optional(),
    payment_status: z.enum(['unpaid', 'paid', 'waived']).optional(),
    payment_method: z.enum(['cash', 'upi', 'card', 'insurance']).optional(),
  });

  app.post('/api/jobs/:id/actions/:action', { preHandler: anyone }, async (req) => {
    const { id: jobId, action } = req.params as { id: string; action: Action };
    const b = ActionBody.parse(req.body ?? {});
    const who = req.user!;
    const j = getJob(jobId);
    if (!canSee(j, who)) throw httpError(404, 'job not found');
    const ref = {
      status: j['status'] as JobStatus,
      kind: j['kind'] as JobKind,
      patient_id: String(j['patient_id']),
      staff_id: (j['staff_id'] as string) ?? null,
    };
    const next = transition(ref, action, { id: who.sub, role: who.role });
    const t = now();
    const sets: Record<string, unknown> = { status: next, updated_at: t };

    if (action === 'assign') {
      if (!b.staff_id) throw httpError(400, 'staff_id is required');
      const r = candidatesFor(jobId).eligible.find((c) => c.id === b.staff_id);
      const forced = !r;
      const st = db
        .prepare('SELECT role FROM users WHERE id = ? AND active = 1')
        .get(b.staff_id) as Row | undefined;
      if (!st || !STAFF.includes(st['role'] as Role))
        throw httpError(400, 'not an active staff member');
      sets['staff_id'] = b.staff_id;
      if (forced) b.note = `${b.note ?? ''} (manual override of dispatch rules)`.trim();
    }
    if (action === 'unassign') sets['staff_id'] = null;
    if (action === 'cancel')
      sets['cancel_reason'] =
        b.reason ?? (who.role === 'patient' ? 'cancelled by patient' : 'cancelled by clinic');
    if (action === 'complete') {
      if (ref.kind === 'delivery' && !OPS.includes(who.role)) {
        if (!b.otp) throw httpError(400, 'enter the 6-digit code from the patient');
        if (b.otp !== j['otp_code']) {
          audit(db, who.sub, 'otp_failed', 'job', jobId);
          throw httpError(400, 'that code does not match');
        }
      }
      if (b.visit_notes !== undefined) sets['visit_notes'] = b.visit_notes;
      if (b.payment_status) sets['payment_status'] = b.payment_status;
      if (b.payment_method) sets['payment_method'] = b.payment_method;
    }
    db.transaction(() => {
      const cols = Object.keys(sets);
      db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...cols.map((c) => sets[c]),
        jobId,
      );
      db.prepare(
        'INSERT INTO job_events (job_id, status, by_user, at, lat, lng, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        jobId,
        action === 'assign' || action === 'unassign' ? `${action}ed` : next,
        who.sub,
        t,
        b.lat ?? null,
        b.lng ?? null,
        b.note ?? b.reason ?? null,
      );
      audit(db, who.sub, action, 'job', jobId, {
        from: ref.status,
        to: next,
        staff_id: sets['staff_id'],
      });
    })();
    if (STAFF.includes(who.role) && b.lat !== undefined && b.lng !== undefined)
      saveLocation(who.sub, b.lat, b.lng, null);
    const events: Partial<Record<Action, JobEvent>> = {
      assign: 'assigned',
      unassign: 'unassigned',
      start: 'start',
      arrive: 'arrive',
      complete: 'complete',
      cancel: 'cancel',
      no_show: 'no_show',
    };
    const ev = events[action];
    if (ev)
      notifyJob(ev, jobId, action === 'assign' || action === 'unassign' ? ref.staff_id : null);
    const updated = getJob(jobId);
    publish('job', {
      ...updated,
      patient_id: String(updated['patient_id']),
      staff_id: (updated['staff_id'] as string) ?? ref.staff_id,
    });
    return viewJob(updated, who, true);
  });

  app.post('/api/jobs/:id/rating', { preHandler: roles('patient') }, async (req) => {
    const { rating } = z.object({ rating: z.number().int().min(1).max(5) }).parse(req.body);
    const j = getJob((req.params as Row)['id'] as string);
    if (j['patient_id'] !== req.user!.sub) throw httpError(404, 'job not found');
    if (j['status'] !== 'completed')
      throw httpError(409, 'you can rate a visit after it is completed');
    db.prepare('UPDATE jobs SET rating = ? WHERE id = ?').run(rating, j['id']);
    audit(db, req.user!.sub, 'rate', 'job', String(j['id']), { rating });
    return { ok: true };
  });

  // ---------- vitals ----------
  const Obs = z
    .array(
      z.object({
        code: z.enum(Object.keys(VITALS) as [VitalCode, ...VitalCode[]]),
        value: z.number(),
        value2: z.number().nullable().optional(),
      }),
    )
    .min(1)
    .max(20);

  app.post(
    '/api/jobs/:id/observations',
    { preHandler: roles('caregiver', 'ops', 'admin') },
    async (req) => {
      const readings = Obs.parse(req.body);
      const who = req.user!;
      const j = getJob((req.params as Row)['id'] as string);
      if (!canSee(j, who)) throw httpError(404, 'job not found');
      if (!['arrived', 'in_progress'].includes(String(j['status'])))
        throw httpError(409, 'record vitals during the visit');
      for (const r of readings) {
        const problem = validateReading(r);
        if (problem) throw httpError(400, problem);
      }
      const t = now();
      const created: Row[] = [];
      const flags: Row[] = [];
      db.transaction(() => {
        for (const r of readings) {
          const oid = id('obs');
          const meta = VITALS[r.code];
          db.prepare(
            'INSERT INTO observations (id, patient_id, job_id, code, loinc, value, value2, unit, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            oid,
            j['patient_id'],
            j['id'],
            r.code,
            meta.loinc,
            r.value,
            r.value2 ?? null,
            meta.unit,
            who.sub,
            t,
          );
          created.push({ id: oid, ...r, unit: meta.unit });
          const flag = assess(r);
          if (flag) {
            const aid = id('alt');
            db.prepare(
              'INSERT INTO alerts (id, patient_id, observation_id, job_id, severity, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(aid, j['patient_id'], oid, j['id'], flag.severity, flag.message, t);
            flags.push({ id: aid, ...flag });
          }
        }
        audit(db, who.sub, 'record_vitals', 'job', String(j['id']), readings);
      })();
      for (const f of flags) publish('alert', { ...f, patient_id: undefined, job_id: j['id'] });
      const critical = flags.filter((f) => f['severity'] === 'critical');
      if (critical.length) {
        const pt = userBrief(j['patient_id'])!;
        const onCall = db
          .prepare("SELECT id, phone FROM users WHERE role IN ('ops','admin') AND active = 1")
          .all() as Row[];
        for (const f of critical)
          notifier.enqueue(
            onCall.map((u) => ({
              userId: String(u['id']),
              phone: String(u['phone']),
              template: 'critical_alert',
              body: `Steadyline Care CRITICAL: ${pt['name']} (${pt['phone']}): ${f['message']}. Open Alerts on the ops board.`,
            })),
            { jobId: String(j['id']), alertId: String(f['id']) },
          );
      }
      return { observations: created, alerts: flags };
    },
  );

  app.get('/api/patient/observations', { preHandler: roles('patient') }, async (req) =>
    db
      .prepare(
        'SELECT code, value, value2, unit, recorded_at, job_id FROM observations WHERE patient_id = ? ORDER BY recorded_at',
      )
      .all(req.user!.sub),
  );

  // ---------- dispatch ----------
  function candidatesFor(jobId: string) {
    const j = getJob(jobId);
    if (j['lat'] == null || j['lng'] == null)
      return { eligible: [], rejected: [{ id: '-', name: '-', reason: 'job has no location' }] };
    const svc = db.prepare('SELECT skill FROM services WHERE id = ?').get(j['service_id']) as Row;
    const start = Date.parse(String(j['starts_at']));
    const day = String(j['starts_at']).slice(0, 10);
    const staffRows = db
      .prepare(
        "SELECT u.id, u.name, s.* FROM users u JOIN staff s ON s.user_id = u.id WHERE u.active = 1 AND u.role IN ('caregiver','courier')",
      )
      .all() as Row[];
    const cands: Candidate[] = staffRows
      .filter((s) => j['kind'] !== 'clinic_visit' || s['site_id'] === j['site_id'])
      .map((s) => {
        const site = s['site_id']
          ? (db.prepare('SELECT lat, lng FROM sites WHERE id = ?').get(s['site_id']) as
              Row | undefined)
          : undefined;
        const base =
          j['kind'] === 'clinic_visit' && site
            ? { lat: Number(site['lat']), lng: Number(site['lng']) }
            : { lat: Number(s['home_lat']), lng: Number(s['home_lng']) };
        return {
          id: String(s['id']),
          name: String(s['name']),
          skills: JSON.parse(String(s['skills'])),
          base,
          maxJobsPerDay: Number(s['max_jobs_per_day']),
          shifts: (
            db
              .prepare(
                'SELECT starts_at, ends_at FROM shifts WHERE staff_id = ? AND ends_at > ? AND starts_at < ?',
              )
              .all(
                s['id'],
                new Date(start - 86_400_000).toISOString(),
                new Date(start + 86_400_000).toISOString(),
              ) as Row[]
          ).map((x) => ({
            start: Date.parse(String(x['starts_at'])),
            end: Date.parse(String(x['ends_at'])),
          })),
          jobs: (
            db
              .prepare(
                "SELECT starts_at, ends_at, lat, lng FROM jobs WHERE staff_id = ? AND id != ? AND substr(starts_at,1,10) = ? AND status NOT IN ('completed','cancelled','no_show')",
              )
              .all(s['id'], jobId, day) as Row[]
          ).map((x) => ({
            start: Date.parse(String(x['starts_at'])),
            end: Date.parse(String(x['ends_at'])),
            at: { lat: Number(x['lat']), lng: Number(x['lng']) },
          })),
        };
      });
    const req: JobRequest = {
      skill: String(svc['skill']),
      start,
      end: Date.parse(String(j['ends_at'])),
      at: { lat: Number(j['lat']), lng: Number(j['lng']) },
    };
    return rank(req, cands);
  }

  function autoAssign(jobId: string, by: string) {
    const j = getJob(jobId);
    if (j['status'] !== 'requested') return { assigned: null, reason: `job is ${j['status']}` };
    const r = candidatesFor(jobId);
    const best = r.eligible[0];
    if (!best) {
      audit(db, by, 'dispatch_failed', 'job', jobId, r.rejected);
      return {
        assigned: null,
        reason: 'nobody available; waiting in the ops queue',
        rejected: r.rejected,
      };
    }
    const t = now();
    db.transaction(() => {
      db.prepare(
        "UPDATE jobs SET staff_id = ?, status = 'assigned', updated_at = ? WHERE id = ?",
      ).run(best.id, t, jobId);
      db.prepare(
        'INSERT INTO job_events (job_id, status, by_user, at, note) VALUES (?, ?, ?, ?, ?)',
      ).run(jobId, 'assigned', by, t, `auto-dispatch: ${best.name}, ${best.reason}`);
      audit(db, by, 'auto_assign', 'job', jobId, best);
    })();
    return { assigned: best };
  }

  // ---------- recurring care plans ----------
  const HORIZON_DAYS = 14;
  const addDays = (date: string, n: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const OPEN_FOR_CHANGE = ['requested', 'assigned'];

  const getPlan = (planId: string, who: Claims) => {
    const p = db.prepare('SELECT * FROM care_plans WHERE id = ?').get(planId) as Row | undefined;
    if (!p || (who.role === 'patient' && p['patient_id'] !== who.sub))
      throw httpError(404, 'care plan not found');
    return p;
  };
  const exceptionFor = (planId: string, date: string) =>
    db.prepare('SELECT * FROM plan_exceptions WHERE plan_id = ? AND date = ?').get(planId, date) as
      Row | undefined;
  /** When an occurrence happens once exceptions are applied; null if skipped. */
  const slotFor = (p: Row, date: string) => {
    const ex = exceptionFor(String(p['id']), date);
    if (ex?.['action'] === 'skip') return null;
    return {
      starts: localToUtc(
        String(ex?.['new_date'] ?? date),
        String(ex?.['time_of_day'] ?? p['time_of_day']),
        Number(p['tz_offset_min']),
      ),
      notes: String(ex?.['notes'] ?? p['notes']),
    };
  };
  const planRule = (p: Row) => parseRule(String(p['rule']), String(p['start_date']));
  const planDates = (p: Row, from: string, to: string) =>
    occurrences(planRule(p), String(p['start_date']), from, to);

  /** Create jobs for the next two weeks of one plan; occurrences that already have a job are left alone. */
  const generatePlan = (p: Row, actor: string) => {
    const created: string[] = [];
    const failed: { date: string; reason: string }[] = [];
    const today = localDate(new Date(), Number(p['tz_offset_min']));
    for (const date of planDates(p, today, addDays(today, HORIZON_DAYS))) {
      const slot = slotFor(p, date);
      if (!slot || slot.starts.getTime() < Date.now()) continue;
      if (db.prepare('SELECT 1 FROM jobs WHERE plan_id = ? AND plan_date = ?').get(p['id'], date))
        continue;
      try {
        const r = createJob(
          {
            service_id: String(p['service_id']),
            starts_at: slot.starts.toISOString(),
            notes: slot.notes,
            site_id: (p['site_id'] as string) ?? undefined,
            items: [],
          },
          String(p['patient_id']),
          actor,
          { id: String(p['id']), date },
        );
        created.push(r.jid);
      } catch (e) {
        const reason = (e as Error).message;
        failed.push({ date, reason });
        audit(db, actor, 'plan_generate_failed', 'care_plan', String(p['id']), { date, reason });
      }
    }
    return { created, failed };
  };
  const generateAll = (actor = 'system') => {
    let created = 0;
    for (const p of db.prepare('SELECT * FROM care_plans WHERE active = 1').all() as Row[])
      created += generatePlan(p, actor).created.length;
    return created;
  };
  app.decorate('generatePlans', generateAll);

  /** Cancel a generated job that has not started yet. */
  const cancelPlanJob = (j: Row, actor: string, reason: string) => {
    const t = now();
    db.transaction(() => {
      db.prepare(
        "UPDATE jobs SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?",
      ).run(reason, t, j['id']);
      db.prepare(
        'INSERT INTO job_events (job_id, status, by_user, at, note) VALUES (?, ?, ?, ?, ?)',
      ).run(j['id'], 'cancelled', actor, t, reason);
      audit(db, actor, 'cancel', 'job', String(j['id']), { reason });
    })();
    notifyJob('cancel', String(j['id']), j['staff_id'] as string | null);
    publish('job', {
      ...getJob(String(j['id'])),
      patient_id: String(j['patient_id']),
      staff_id: (j['staff_id'] as string) ?? null,
    });
  };

  const PlanInput = z.object({
    service_id: z.string(),
    site_id: z.string().optional(),
    rule: z.string().min(1).max(200),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time_of_day: z.string().regex(/^\d{2}:\d{2}$/),
    tz_offset_min: z.number().int().min(-720).max(840).default(330),
    notes: z.string().max(1000).default(''),
    patient_id: z.string().optional(),
  });
  const planView = (p: Row) => {
    const today = localDate(new Date(), Number(p['tz_offset_min']));
    const upcoming = p['active']
      ? planDates(p, today, addDays(today, 60))
          .slice(0, 8)
          .map((date) => {
            const slot = slotFor(p, date);
            const job = db
              .prepare(
                'SELECT id, status, starts_at, staff_id FROM jobs WHERE plan_id = ? AND plan_date = ?',
              )
              .get(p['id'], date) as Row | undefined;
            return {
              date,
              skipped: !slot,
              starts_at: slot?.starts.toISOString() ?? null,
              modified: exceptionFor(String(p['id']), date)?.['action'] === 'modify',
              job: job ?? null,
            };
          })
      : [];
    const svc = db.prepare('SELECT name FROM services WHERE id = ?').get(p['service_id']) as Row;
    return { ...p, active: !!p['active'], service_name: svc['name'], upcoming };
  };

  app.post('/api/care-plans', { preHandler: roles('patient', 'ops', 'admin') }, async (req) => {
    const b = PlanInput.parse(req.body);
    const who = req.user!;
    const patientId = who.role === 'patient' ? who.sub : b.patient_id;
    if (!patientId) throw httpError(400, 'patient_id is required when booking for someone');
    const svc = db
      .prepare('SELECT kind FROM services WHERE id = ? AND active = 1')
      .get(b.service_id) as Row | undefined;
    if (!svc) throw httpError(400, 'unknown service');
    if (svc['kind'] === 'delivery')
      throw httpError(400, 'deliveries need a code each time; book them one by one');
    try {
      localToUtc(b.start_date, b.time_of_day, b.tz_offset_min);
      const rule = parseRule(b.rule, b.start_date);
      if (!occurrences(rule, b.start_date, b.start_date, addDays(b.start_date, 400)).length)
        throw new RuleError('the rule never produces a visit');
    } catch (e) {
      if (e instanceof RuleError) throw httpError(400, e.message);
      throw e;
    }
    readProfile(patientId); // 404 if not a patient
    const pid = id('plan');
    db.transaction(() => {
      db.prepare(
        `INSERT INTO care_plans (id, patient_id, service_id, site_id, rule, start_date, time_of_day, tz_offset_min, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        pid,
        patientId,
        b.service_id,
        b.site_id ?? null,
        b.rule
          .trim()
          .replace(/^RRULE:/i, '')
          .toUpperCase(),
        b.start_date,
        b.time_of_day,
        b.tz_offset_min,
        b.notes,
        who.sub,
        now(),
      );
      audit(db, who.sub, 'create', 'care_plan', pid, { rule: b.rule, service: b.service_id });
    })();
    const plan = db.prepare('SELECT * FROM care_plans WHERE id = ?').get(pid) as Row;
    const generated = generatePlan(plan, who.sub);
    return { plan: planView(plan), generated };
  });

  app.get('/api/care-plans', { preHandler: roles('patient', 'ops', 'admin') }, async (req) => {
    const who = req.user!;
    const rows = (
      who.role === 'patient'
        ? db
            .prepare('SELECT * FROM care_plans WHERE patient_id = ? ORDER BY created_at DESC')
            .all(who.sub)
        : db.prepare('SELECT * FROM care_plans ORDER BY created_at DESC LIMIT 200').all()
    ) as Row[];
    return rows.map(planView);
  });

  app.post(
    '/api/care-plans/:id/occurrences/:date',
    { preHandler: roles('patient', 'ops', 'admin') },
    async (req) => {
      const { id: planId, date } = req.params as { id: string; date: string };
      const b = z
        .object({
          action: z.enum(['skip', 'modify', 'restore']),
          time_of_day: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .optional(),
          new_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          notes: z.string().max(1000).optional(),
        })
        .parse(req.body);
      const who = req.user!;
      const p = getPlan(planId, who);
      if (!p['active']) throw httpError(409, 'this care plan has ended');
      if (!planDates(p, date, date).length) throw httpError(404, 'no visit on that date');
      if (b.action === 'modify' && !b.time_of_day && !b.new_date && b.notes === undefined)
        throw httpError(400, 'say what to change: time_of_day, new_date or notes');
      if (b.time_of_day || b.new_date) {
        try {
          localToUtc(b.new_date ?? date, b.time_of_day ?? '00:00', 0);
          if (b.new_date) localToUtc(b.new_date, '00:00', 0);
        } catch {
          throw httpError(400, 'invalid date or time');
        }
      }
      const job = db
        .prepare('SELECT * FROM jobs WHERE plan_id = ? AND plan_date = ?')
        .get(planId, date) as Row | undefined;
      if (job && ![...OPEN_FOR_CHANGE, 'cancelled'].includes(String(job['status'])))
        throw httpError(409, `that visit is already ${String(job['status'])}`);

      db.transaction(() => {
        if (b.action === 'restore')
          db.prepare('DELETE FROM plan_exceptions WHERE plan_id = ? AND date = ?').run(
            planId,
            date,
          );
        else
          db.prepare(
            `INSERT INTO plan_exceptions (plan_id, date, action, time_of_day, new_date, notes) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(plan_id, date) DO UPDATE SET action = excluded.action, time_of_day = excluded.time_of_day, new_date = excluded.new_date, notes = excluded.notes`,
          ).run(
            planId,
            date,
            b.action,
            b.action === 'modify' ? (b.time_of_day ?? null) : null,
            b.action === 'modify' ? (b.new_date ?? null) : null,
            b.action === 'modify' ? (b.notes ?? null) : null,
          );
        audit(db, who.sub, `plan_${b.action}`, 'care_plan', planId, { date, ...b });
      })();

      if (job && b.action === 'skip') {
        if (job['status'] !== 'cancelled') cancelPlanJob(job, who.sub, 'skipped from care plan');
      } else if (job) {
        // Moved or restored: cancel the generated visit and book the new slot, so dispatch and
        // notifications run exactly as for a fresh booking. The same (plan, date) key is reused.
        if (job['status'] !== 'cancelled')
          cancelPlanJob(job, who.sub, 'rescheduled from care plan');
        db.prepare('UPDATE jobs SET plan_date = ? WHERE id = ?').run(`${date}#old`, job['id']);
        generatePlan(p, who.sub);
      } else if (b.action !== 'skip') generatePlan(p, who.sub);
      return planView(db.prepare('SELECT * FROM care_plans WHERE id = ?').get(planId) as Row);
    },
  );

  app.post(
    '/api/care-plans/:id/end',
    { preHandler: roles('patient', 'ops', 'admin') },
    async (req) => {
      const who = req.user!;
      const p = getPlan((req.params as Row)['id'] as string, who);
      db.prepare('UPDATE care_plans SET active = 0 WHERE id = ?').run(p['id']);
      audit(db, who.sub, 'end', 'care_plan', String(p['id']));
      const open = db
        .prepare(
          `SELECT * FROM jobs WHERE plan_id = ? AND status IN ('requested','assigned') AND starts_at > ?`,
        )
        .all(p['id'], now()) as Row[];
      for (const j of open) cancelPlanJob(j, who.sub, 'care plan ended');
      return { ...planView({ ...p, active: 0 }), cancelled_jobs: open.length };
    },
  );

  app.post('/api/ops/care-plans/generate', { preHandler: roles('ops', 'admin') }, async (req) => ({
    created: generateAll(req.user!.sub),
  }));

  app.get('/api/jobs/:id/candidates', { preHandler: roles('ops', 'admin') }, async (req) =>
    candidatesFor((req.params as Row)['id'] as string),
  );
  app.post('/api/jobs/:id/auto-assign', { preHandler: roles('ops', 'admin') }, async (req) => {
    const jid = (req.params as Row)['id'] as string;
    const r = autoAssign(jid, req.user!.sub);
    if (r.assigned) notifyJob('assigned', jid);
    const j = getJob(jid);
    publish('job', {
      ...j,
      patient_id: String(j['patient_id']),
      staff_id: j['staff_id'] as string,
    });
    return r;
  });

  // ---------- staff ----------
  app.get('/api/staff/today', { preHandler: roles('caregiver', 'courier') }, async (req) => {
    const q = z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(req.query);
    const day = q.date ?? new Date().toISOString().slice(0, 10);
    const rows = db
      .prepare(
        'SELECT * FROM jobs WHERE staff_id = ? AND substr(starts_at,1,10) = ? ORDER BY starts_at',
      )
      .all(req.user!.sub, day) as Row[];
    return rows.map((r) => viewJob(r, req.user!));
  });

  // ---------- ops ----------
  app.get('/api/ops/board', { preHandler: roles('ops', 'admin') }, async (req) => {
    const q = z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(req.query);
    const day = q.date ?? new Date().toISOString().slice(0, 10);
    const jobs = (
      db
        .prepare(
          "SELECT * FROM jobs WHERE substr(starts_at,1,10) = ? OR status = 'requested' ORDER BY starts_at",
        )
        .all(day) as Row[]
    ).map((r) => viewJob(r, req.user!));
    const staff = db
      .prepare(
        `SELECT u.id, u.name, u.role, u.phone, s.skills, s.site_id,
              (SELECT COUNT(*) FROM jobs j WHERE j.staff_id = u.id AND substr(j.starts_at,1,10) = ? AND j.status NOT IN ('cancelled','no_show')) AS jobs_today,
              (SELECT COUNT(*) FROM shifts sh WHERE sh.staff_id = u.id AND substr(sh.starts_at,1,10) = ?) AS on_shift
         FROM users u JOIN staff s ON s.user_id = u.id WHERE u.active = 1 ORDER BY u.name`,
      )
      .all(day, day) as Row[];
    const openAlerts = db
      .prepare('SELECT COUNT(*) AS n FROM alerts WHERE acknowledged_at IS NULL')
      .get() as Row;
    const counts: Record<string, number> = {};
    for (const j of jobs) counts[String(j['status'])] = (counts[String(j['status'])] ?? 0) + 1;
    return {
      date: day,
      counts,
      open_alerts: openAlerts['n'],
      jobs,
      staff: staff.map((s) => ({ ...s, skills: JSON.parse(String(s['skills'])) })),
    };
  });

  app.get('/api/ops/alerts', { preHandler: roles('ops', 'admin') }, async (req) => {
    const q = z.object({ open: z.enum(['1', '0']).default('1') }).parse(req.query);
    return db
      .prepare(
        `SELECT a.*, u.name AS patient_name, u.phone AS patient_phone FROM alerts a JOIN users u ON u.id = a.patient_id
       ${q.open === '1' ? 'WHERE a.acknowledged_at IS NULL' : ''} ORDER BY a.severity = 'critical' DESC, a.created_at DESC LIMIT 200`,
      )
      .all();
  });
  app.post('/api/ops/alerts/:id/ack', { preHandler: roles('ops', 'admin') }, async (req) => {
    const { resolution } = z
      .object({ resolution: z.string().trim().min(3).max(1000) })
      .parse(req.body);
    const aid = (req.params as Row)['id'] as string;
    const r = db
      .prepare(
        'UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ?, resolution = ? WHERE id = ? AND acknowledged_at IS NULL',
      )
      .run(req.user!.sub, now(), resolution, aid);
    if (!r.changes) throw httpError(404, 'alert not found or already handled');
    audit(db, req.user!.sub, 'ack_alert', 'alert', aid, { resolution });
    return { ok: true };
  });

  const StaffInput = z.object({
    role: z.enum(['caregiver', 'courier', 'ops']),
    name: z.string().trim().min(2),
    phone: Phone,
    password: Password,
    skills: z.array(z.string()).default([]),
    license: z.string().max(60).optional(),
    home_lat: z.number().min(-90).max(90),
    home_lng: z.number().min(-180).max(180),
    site_id: z.string().optional(),
    max_jobs_per_day: z.number().int().min(1).max(30).default(8),
  });
  app.post('/api/ops/staff', { preHandler: roles('admin') }, async (req) => {
    const b = StaffInput.parse(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(b.phone))
      throw httpError(409, 'that phone number is already registered');
    const uid = id('usr');
    db.transaction(() => {
      db.prepare(
        'INSERT INTO users (id, role, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(uid, b.role, b.name, b.phone, hashPassword(b.password), now());
      if (b.role !== 'ops')
        db.prepare(
          'INSERT INTO staff (user_id, skills, license, home_lat, home_lng, site_id, max_jobs_per_day) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          uid,
          JSON.stringify(b.skills),
          b.license ?? null,
          b.home_lat,
          b.home_lng,
          b.site_id ?? null,
          b.max_jobs_per_day,
        );
      audit(db, req.user!.sub, 'create_staff', 'user', uid, { role: b.role, skills: b.skills });
    })();
    return { id: uid };
  });
  app.post('/api/ops/staff/:id/active', { preHandler: roles('admin') }, async (req) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const uid = (req.params as Row)['id'] as string;
    db.prepare("UPDATE users SET active = ? WHERE id = ? AND role != 'admin'").run(
      active ? 1 : 0,
      uid,
    );
    audit(db, req.user!.sub, active ? 'activate' : 'deactivate', 'user', uid);
    return { ok: true };
  });

  app.post('/api/ops/shifts', { preHandler: roles('ops', 'admin') }, async (req) => {
    const b = z
      .object({
        staff_id: z.string(),
        starts_at: z.string().datetime({ offset: true }),
        ends_at: z.string().datetime({ offset: true }),
      })
      .parse(req.body);
    if (Date.parse(b.ends_at) <= Date.parse(b.starts_at))
      throw httpError(400, 'shift must end after it starts');
    if (Date.parse(b.ends_at) - Date.parse(b.starts_at) > 16 * 3600_000)
      throw httpError(400, 'shifts are limited to 16 hours');
    if (!db.prepare('SELECT 1 FROM staff WHERE user_id = ?').get(b.staff_id))
      throw httpError(400, 'unknown staff member');
    const sid = id('shf');
    db.prepare('INSERT INTO shifts (id, staff_id, starts_at, ends_at) VALUES (?, ?, ?, ?)').run(
      sid,
      b.staff_id,
      new Date(b.starts_at).toISOString(),
      new Date(b.ends_at).toISOString(),
    );
    audit(db, req.user!.sub, 'create_shift', 'shift', sid, b);
    return { id: sid };
  });
  app.get('/api/ops/shifts', { preHandler: roles('ops', 'admin') }, async (req) => {
    const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    return db
      .prepare(
        'SELECT sh.*, u.name FROM shifts sh JOIN users u ON u.id = sh.staff_id WHERE substr(sh.starts_at,1,10) = ? ORDER BY sh.starts_at',
      )
      .all(q.date);
  });

  app.get('/api/ops/patients', { preHandler: roles('ops', 'admin') }, async (req) => {
    const q = z.object({ q: z.string().max(60).default('') }).parse(req.query);
    return db
      .prepare(
        `SELECT u.id, u.name, u.phone, p.address, p.conditions FROM users u JOIN patients p ON p.user_id = u.id
       WHERE u.name LIKE ? OR u.phone LIKE ? ORDER BY u.name LIMIT 50`,
      )
      .all(`%${q.q}%`, `%${q.q}%`);
  });
  app.get('/api/ops/patients/:id', { preHandler: roles('ops', 'admin') }, async (req) => {
    const pid = (req.params as Row)['id'] as string;
    audit(db, req.user!.sub, 'view_record', 'patient', pid);
    return {
      profile: readProfile(pid),
      jobs: (
        db
          .prepare('SELECT * FROM jobs WHERE patient_id = ? ORDER BY starts_at DESC LIMIT 100')
          .all(pid) as Row[]
      ).map((j) => viewJob(j, req.user!)),
      observations: db
        .prepare('SELECT * FROM observations WHERE patient_id = ? ORDER BY recorded_at')
        .all(pid),
      alerts: db
        .prepare('SELECT * FROM alerts WHERE patient_id = ? ORDER BY created_at DESC')
        .all(pid),
    };
  });

  // ---------- live location ----------
  function saveLocation(staffId: string, lat: number, lng: number, accuracy: number | null) {
    db.prepare(
      `INSERT INTO staff_locations (staff_id, lat, lng, accuracy, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(staff_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, at = excluded.at`,
    ).run(staffId, lat, lng, accuracy, now());
  }

  app.post('/api/staff/location', { preHandler: roles('caregiver', 'courier') }, async (req) => {
    const b = z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100_000).optional(),
      })
      .parse(req.body);
    saveLocation(req.user!.sub, b.lat, b.lng, b.accuracy ?? null);
    // Patients of this staff member's active trips get a fresh ETA.
    const trips = db
      .prepare("SELECT * FROM jobs WHERE staff_id = ? AND status = 'en_route'")
      .all(req.user!.sub) as Row[];
    for (const t of trips)
      publish('job', { ...t, patient_id: String(t['patient_id']), staff_id: req.user!.sub });
    publish('location', { id: req.user!.sub, status: 'moved' });
    return { ok: true, active_trips: trips.length };
  });

  app.get('/api/ops/live', { preHandler: roles('ops', 'admin') }, async () => {
    const staff = db
      .prepare(
        `SELECT u.id, u.name, u.role, u.phone, l.lat, l.lng, l.at FROM staff_locations l JOIN users u ON u.id = l.staff_id
          WHERE u.active = 1 AND l.at > ? ORDER BY u.name`,
      )
      .all(new Date(Date.now() - 30 * 60_000).toISOString()) as Row[];
    const jobs = (
      db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('assigned','en_route','arrived','in_progress') AND lat IS NOT NULL AND substr(starts_at,1,10) <= ? ORDER BY starts_at",
        )
        .all(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) as Row[]
    ).map((j) => ({
      id: j['id'],
      status: j['status'],
      kind: j['kind'],
      lat: j['lat'],
      lng: j['lng'],
      starts_at: j['starts_at'],
      address: j['address'],
      staff_id: j['staff_id'],
      patient: (userBrief(j['patient_id']) ?? {})['name'],
      ...(etaFor(j) ?? {}),
    }));
    return { staff, jobs };
  });

  app.get('/api/ops/notifications', { preHandler: roles('ops', 'admin') }, async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    return db
      .prepare(
        'SELECT n.*, u.name AS user_name FROM notifications n LEFT JOIN users u ON u.id = n.user_id ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?',
      )
      .all(q.limit);
  });

  // ---------- catalog administration ----------
  const SiteInput = z.object({
    name: z.string().trim().min(2).max(120),
    address: z.string().trim().min(5).max(300),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    kind: z.enum(['clinic', 'depot']),
  });
  app.post('/api/ops/sites', { preHandler: roles('admin') }, async (req) => {
    const b = SiteInput.parse(req.body);
    const sid = id('site');
    db.prepare(
      'INSERT INTO sites (id, name, address, lat, lng, kind) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sid, b.name, b.address, b.lat, b.lng, b.kind);
    audit(db, req.user!.sub, 'create_site', 'site', sid, b);
    return { id: sid };
  });

  const ServiceInput = z.object({
    name: z.string().trim().min(2).max(120),
    kind: z.enum(['home_visit', 'clinic_visit', 'delivery']),
    skill: z.string().trim().min(2).max(40),
    duration_min: z.number().int().min(5).max(720),
    price_paise: z.number().int().min(0).max(100_000_00),
    description: z.string().max(500).default(''),
    active: z.boolean().default(true),
  });
  app.get('/api/ops/services', { preHandler: roles('ops', 'admin') }, async () =>
    db.prepare('SELECT * FROM services ORDER BY active DESC, kind, name').all(),
  );
  app.post('/api/ops/services', { preHandler: roles('admin') }, async (req) => {
    const b = ServiceInput.parse(req.body);
    const sid = id('svc');
    db.prepare(
      'INSERT INTO services (id, name, kind, skill, duration_min, price_paise, description, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sid,
      b.name,
      b.kind,
      b.skill,
      b.duration_min,
      b.price_paise,
      b.description,
      b.active ? 1 : 0,
    );
    audit(db, req.user!.sub, 'create_service', 'service', sid, b);
    return { id: sid };
  });
  app.put('/api/ops/services/:id', { preHandler: roles('admin') }, async (req) => {
    const b = ServiceInput.partial().parse(req.body);
    const sid = (req.params as Row)['id'] as string;
    const cur = db.prepare('SELECT * FROM services WHERE id = ?').get(sid) as Row | undefined;
    if (!cur) throw httpError(404, 'service not found');
    // Price changes apply to new bookings only; existing jobs keep the price they were booked at.
    const next = {
      ...cur,
      ...b,
      active: b.active === undefined ? cur['active'] : b.active ? 1 : 0,
    };
    db.prepare(
      'UPDATE services SET name = ?, kind = ?, skill = ?, duration_min = ?, price_paise = ?, description = ?, active = ? WHERE id = ?',
    ).run(
      next['name'],
      next['kind'],
      next['skill'],
      next['duration_min'],
      next['price_paise'],
      next['description'],
      next['active'],
      sid,
    );
    audit(db, req.user!.sub, 'update_service', 'service', sid, b);
    return db.prepare('SELECT * FROM services WHERE id = ?').get(sid);
  });

  app.get('/api/ops/audit', { preHandler: roles('admin') }, async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(1000).default(200) })
      .parse(req.query);
    return db
      .prepare(
        'SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?',
      )
      .all(q.limit);
  });

  app.get('/api/ops/metrics', { preHandler: roles('ops', 'admin') }, async () => ({
    jobs_by_status: db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all(),
    revenue_paid_paise: (
      db
        .prepare("SELECT COALESCE(SUM(price_paise),0) AS s FROM jobs WHERE payment_status = 'paid'")
        .get() as Row
    )['s'],
    avg_rating: (
      db.prepare('SELECT ROUND(AVG(rating),2) AS r FROM jobs WHERE rating IS NOT NULL').get() as Row
    )['r'],
    on_time_rate: onTimeRate(db),
  }));

  // ---------- payments ----------
  const payerOf = (j: Row, who: Claims) => {
    if (!(OPS.includes(who.role) || j['patient_id'] === who.sub))
      throw httpError(404, 'job not found');
  };
  const invoiceNo = (j: Row) => 'INV-' + String(j['id']).slice(-8).toUpperCase();

  app.post(
    '/api/jobs/:id/payment-link',
    { preHandler: roles('patient', 'ops', 'admin') },
    async (req) => {
      const j = getJob((req.params as Row)['id'] as string);
      payerOf(j, req.user!);
      if (!payments) throw httpError(501, 'online payments are not configured');
      if (j['payment_status'] !== 'unpaid') throw httpError(409, 'this visit is already settled');
      if (j['status'] === 'cancelled') throw httpError(409, 'this visit was cancelled');
      const amount = Number(j['price_paise']);
      if (amount <= 0) throw httpError(409, 'nothing to pay');
      const open = db
        .prepare(
          "SELECT link_url, link_ref FROM payments WHERE job_id = ? AND status = 'created' AND provider = ? AND amount_paise = ?",
        )
        .get(j['id'], payments.name, amount) as Row | undefined;
      if (open) return { url: open['link_url'], reused: true };
      const svc = db.prepare('SELECT name FROM services WHERE id = ?').get(j['service_id']) as Row;
      const patient = userBrief(j['patient_id'])!;
      let link;
      try {
        link = await payments.createLink({
          amountPaise: amount,
          reference: String(j['id']),
          description: `${svc['name']} on ${String(j['starts_at']).slice(0, 10)}`,
          customer: { name: String(patient['name']), phone: String(patient['phone']) },
        });
      } catch (e) {
        console.error('payment link failed', (e as Error).message);
        throw httpError(502, 'the payment provider could not create a link; try again');
      }
      db.prepare(
        "INSERT INTO payments (id, job_id, provider, link_ref, link_url, amount_paise, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'created', ?)",
      ).run(id('pay'), j['id'], payments.name, link.ref, link.url, amount, now());
      audit(db, req.user!.sub, 'payment_link', 'job', String(j['id']), { amount, ref: link.ref });
      return { url: link.url, reused: false };
    },
  );

  app.post('/api/webhooks/razorpay', async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const sig = req.headers['x-razorpay-signature'];
    if (!verifyWebhookSignature(raw, typeof sig === 'string' ? sig : undefined, webhookSecret))
      return reply.status(401).send({ error: 'bad signature' });
    const ev = parsePaidEvent(req.body);
    if (!ev) return { ok: true, ignored: true };
    const eventId = String(req.headers['x-razorpay-event-id'] ?? '') || null;
    const p = db.prepare('SELECT * FROM payments WHERE link_ref = ?').get(ev.linkRef) as
      Row | undefined;
    if (!p) return { ok: true, ignored: true };
    if (p['status'] === 'paid') return { ok: true, duplicate: true };
    if (ev.amountPaise !== p['amount_paise'] || ev.reference !== p['job_id']) {
      audit(db, null, 'payment_mismatch', 'job', String(p['job_id']), ev);
      return reply.status(422).send({ error: 'amount or reference does not match the link' });
    }
    const method = ev.method === 'upi' || ev.method === 'card' ? ev.method : null;
    const paidAt = now();
    db.transaction(() => {
      db.prepare(
        "UPDATE payments SET status = 'paid', method = ?, payment_ref = ?, event_id = ?, receipt_no = ?, paid_at = ? WHERE id = ?",
      ).run(
        method ?? ev.method,
        ev.paymentRef,
        eventId,
        'RCT-' + String(p['id']).slice(-8).toUpperCase(),
        paidAt,
        p['id'],
      );
      db.prepare(
        "UPDATE jobs SET payment_status = 'paid', payment_method = COALESCE(?, payment_method, 'card'), updated_at = ? WHERE id = ? AND payment_status = 'unpaid'",
      ).run(method, paidAt, p['job_id']);
      audit(db, null, 'payment_received', 'job', String(p['job_id']), {
        ref: ev.paymentRef,
        amount: ev.amountPaise,
      });
    })();
    const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(p['job_id']) as Row;
    publish('job', {
      patient_id: j['patient_id'] as string,
      staff_id: j['staff_id'] as string | null,
      id: j['id'],
    });
    return { ok: true };
  });

  /** Invoice while unpaid, receipt once paid. */
  app.get('/api/jobs/:id/invoice.pdf', { preHandler: anyone }, async (req, reply) => {
    const j = getJob((req.params as Row)['id'] as string);
    if (!(OPS.includes(req.user!.role) || j['patient_id'] === req.user!.sub))
      throw httpError(404, 'job not found');
    const svc = db.prepare('SELECT name FROM services WHERE id = ?').get(j['service_id']) as Row;
    const pay = db
      .prepare("SELECT * FROM payments WHERE job_id = ? AND status = 'paid' ORDER BY paid_at DESC")
      .get(j['id']) as Row | undefined;
    const paid = j['payment_status'] === 'paid';
    const waived = j['payment_status'] === 'waived';
    const pdf = invoicePdf({
      number: paid && pay ? String(pay['receipt_no']) : invoiceNo(j),
      issuedAt: now(),
      patient: String(userBrief(j['patient_id'])!['name']),
      service: String(svc['name']),
      serviceDate: String(j['starts_at']).slice(0, 10),
      amountPaise: waived ? 0 : Number(j['price_paise']),
      paid: paid || waived,
      paidAt: pay ? String(pay['paid_at']) : String(j['updated_at']),
      method: waived ? 'waiver' : String(pay?.['method'] ?? j['payment_method'] ?? ''),
      reference: pay ? String(pay['payment_ref'] ?? '') : null,
    });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${invoiceNo(j)}.pdf"`)
      .send(pdf);
  });

  // ---------- live updates ----------
  app.get('/api/events', { preHandler: anyone }, async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    reply.raw.write(': connected\n\n');
    const fn: Listener = (e) =>
      reply.raw.write(
        `event: ${e.type}\ndata: ${JSON.stringify({ id: (e.data as Row)['id'], status: (e.data as Row)['status'] })}\n\n`,
      );
    listeners.set(fn, req.user!);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      listeners.delete(fn);
    });
    return reply;
  });

  app.get('/api/health', async () => ({
    ok: true,
    open_jobs: (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('completed','cancelled','no_show')",
        )
        .get() as Row
    )['n'],
  }));

  if (publicDir && existsSync(publicDir)) {
    void app.register(fastifyStatic, { root: publicDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.status(404).send({ error: 'not found' })
        : reply.sendFile('index.html'),
    );
  }

  void isOpen;
  return app as typeof app & { generatePlans: typeof generateAll };
}

function onTimeRate(db: DB): number | null {
  const rows = db
    .prepare(
      `SELECT j.starts_at, (SELECT MIN(at) FROM job_events e WHERE e.job_id = j.id AND e.status = 'arrived') AS arrived
       FROM jobs j WHERE j.kind = 'home_visit' AND j.status = 'completed'`,
    )
    .all() as Row[];
  const timed = rows.filter((r) => r['arrived']);
  if (!timed.length) return null;
  const onTime = timed.filter(
    (r) => Date.parse(String(r['arrived'])) <= Date.parse(String(r['starts_at'])) + 15 * 60_000,
  );
  return Math.round((onTime.length / timed.length) * 100) / 100;
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
