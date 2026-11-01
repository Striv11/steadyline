/**
 * Notifications: who hears what, when. Messages are written to the
 * `notifications` outbox first (so every message is auditable and visible to
 * admins), then handed to a provider. Without provider credentials the outbox
 * still records everything with status "logged", so the platform works on day one.
 *
 * Providers:
 *  - log (default): records only
 *  - twilio: SMS or WhatsApp via Twilio's REST API
 *    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM ("+1..." or "whatsapp:+1..."),
 *    NOTIFY_CHANNEL = sms | whatsapp
 */
import { id, now, type DB } from './db.js';

export type Channel = 'sms' | 'whatsapp';

export interface Provider {
  name: string;
  send(to: string, body: string): Promise<{ ref: string }>;
}

export const logProvider: Provider = {
  name: 'log',
  send: async () => ({ ref: 'logged' }),
};

/** Normalize Indian 10-digit numbers to E.164 (+91…); pass through numbers that already have a country code. */
export function e164(phone: string, defaultCountry = '+91'): string {
  const p = phone.replace(/[^\d+]/g, '');
  if (p.startsWith('+')) return p;
  if (p.length === 10) return defaultCountry + p;
  if (p.length === 12 && p.startsWith('91')) return '+' + p;
  return '+' + p;
}

export function twilioProvider(opts: {
  sid: string;
  token: string;
  from: string;
  channel: Channel;
  fetchFn?: typeof fetch;
}): Provider {
  const f = opts.fetchFn ?? fetch;
  return {
    name: `twilio-${opts.channel}`,
    async send(to, body) {
      const dest = opts.channel === 'whatsapp' ? `whatsapp:${e164(to)}` : e164(to);
      const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${opts.sid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${opts.sid}:${opts.token}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: dest, From: opts.from, Body: body }).toString(),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok) throw new Error(`twilio ${res.status}: ${data.message ?? 'send failed'}`);
      return { ref: data.sid ?? 'unknown' };
    },
  };
}

export function providerFromEnv(env = process.env): Provider {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
  if (sid && token && from)
    return twilioProvider({
      sid,
      token,
      from,
      channel: env['NOTIFY_CHANNEL'] === 'whatsapp' ? 'whatsapp' : 'sms',
    });
  return logProvider;
}

export type JobEvent =
  'booked' | 'assigned' | 'unassigned' | 'start' | 'arrive' | 'complete' | 'cancel' | 'no_show';

type Row = Record<string, unknown>;

const BRAND = 'Steadyline Care';

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: process.env['TZ_DISPLAY'] ?? 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

export interface Message {
  userId: string | null;
  phone: string;
  template: string;
  body: string;
}

/** Build the messages a job event should produce. Pure, so it is unit-tested directly. */
export function messagesFor(
  event: JobEvent,
  job: Row,
  ctx: {
    service: string;
    patient: Row;
    staff: Row | null;
    previousStaff?: Row | null;
    etaMin?: number | null;
  },
): Message[] {
  const out: Message[] = [];
  const toPatient = (template: string, body: string) =>
    out.push({
      userId: String(job['patient_id']),
      phone: String(ctx.patient['phone']),
      template,
      body: `${BRAND}: ${body}`,
    });
  const toStaff = (s: Row | null | undefined, template: string, body: string) => {
    if (s)
      out.push({
        userId: String(s['id']),
        phone: String(s['phone']),
        template,
        body: `${BRAND}: ${body}`,
      });
  };
  const when = fmtTime(String(job['starts_at']));
  const where = String(job['address']);
  const isDelivery = job['kind'] === 'delivery';
  const staffName = ctx.staff ? String(ctx.staff['name']) : '';

  switch (event) {
    case 'booked':
      toPatient(
        'booked',
        `your ${ctx.service} is booked for ${when}.${isDelivery ? ` Your delivery code is ${job['otp_code']}; give it to the courier only when you receive your items.` : ''}`,
      );
      break;
    case 'assigned':
      toPatient(
        'assigned',
        `${staffName} will ${isDelivery ? 'deliver your order' : 'see you'} on ${when}.`,
      );
      toStaff(
        ctx.staff,
        'staff_assigned',
        `new job: ${ctx.service} for ${ctx.patient['name']}, ${when}, ${where}.`,
      );
      if (ctx.previousStaff && ctx.previousStaff['id'] !== ctx.staff?.['id'])
        toStaff(
          ctx.previousStaff,
          'staff_unassigned',
          `the ${when} job for ${ctx.patient['name']} has been moved to someone else.`,
        );
      break;
    case 'unassigned':
      toStaff(
        ctx.previousStaff,
        'staff_unassigned',
        `the ${when} job for ${ctx.patient['name']} has been removed from your day.`,
      );
      break;
    case 'start':
      toPatient(
        'on_the_way',
        `${staffName} is on the way${ctx.etaMin ? `, arriving in about ${ctx.etaMin} min` : ''}.${isDelivery ? ` Keep your code ready: ${job['otp_code']}.` : ''}`,
      );
      break;
    case 'complete':
      toPatient(
        'completed',
        isDelivery
          ? 'your order was delivered. Thank you.'
          : `your ${ctx.service} is complete. Visit notes and readings are in your account. Please rate your visit.`,
      );
      break;
    case 'cancel':
      toPatient(
        'cancelled',
        `your ${ctx.service} on ${when} was cancelled${job['cancel_reason'] ? ` (${job['cancel_reason']})` : ''}.`,
      );
      toStaff(
        ctx.staff,
        'staff_cancelled',
        `cancelled: ${ctx.service} for ${ctx.patient['name']} on ${when}.`,
      );
      break;
    case 'no_show':
      toPatient(
        'no_show',
        `we could not complete your ${ctx.service} on ${when}. Please call us to rebook.`,
      );
      break;
    case 'arrive':
      break; // the patient sees the caregiver at the door; no message needed
  }
  return out;
}

export class Notifier {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DB,
    private readonly provider: Provider = logProvider,
  ) {}

  /** Record messages, then send them in the background (in order). Never throws into the request. */
  enqueue(messages: Message[], related: { jobId?: string; alertId?: string } = {}): void {
    for (const m of messages) {
      const nid = id('ntf');
      this.db
        .prepare(
          'INSERT INTO notifications (id, user_id, to_phone, template, body, job_id, alert_id, status, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          nid,
          m.userId,
          m.phone,
          m.template,
          m.body,
          related.jobId ?? null,
          related.alertId ?? null,
          'queued',
          this.provider.name,
          now(),
        );
      this.queue = this.queue.then(() => this.deliver(nid, m));
    }
  }

  private async deliver(nid: string, m: Message): Promise<void> {
    try {
      const r = await this.provider.send(m.phone, m.body);
      this.db
        .prepare('UPDATE notifications SET status = ?, provider_ref = ?, sent_at = ? WHERE id = ?')
        .run(this.provider.name === 'log' ? 'logged' : 'sent', r.ref, now(), nid);
    } catch (e) {
      this.db
        .prepare("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?")
        .run(String((e as Error).message).slice(0, 300), nid);
    }
  }

  /** Resolves when everything enqueued so far has been attempted (tests, graceful shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }
}
