import { describe, expect, it, vi } from 'vitest';
import { e164, messagesFor, twilioProvider } from '../src/notify.js';

const job = {
  id: 'job_1',
  patient_id: 'p1',
  staff_id: 's1',
  kind: 'home_visit',
  starts_at: '2026-11-02T05:30:00.000Z',
  address: 'Karve Nagar, Pune',
  otp_code: null,
  cancel_reason: null,
};
const patient = { id: 'p1', name: 'Asha', phone: '9876500000' };
const nurse = { id: 's1', name: 'Anita', phone: '9100000001' };
const other = { id: 's2', name: 'Rahul', phone: '9100000002' };

describe('message rules', () => {
  it('booking tells the patient; a delivery includes the handover code', () => {
    const m = messagesFor('booked', job, { service: 'Nursing visit', patient, staff: null });
    expect(m).toHaveLength(1);
    expect(m[0]!.phone).toBe('9876500000');
    expect(m[0]!.body).toMatch(/Nursing visit is booked for Mon, 2 Nov.*11:00/);
    const d = messagesFor(
      'booked',
      { ...job, kind: 'delivery', otp_code: '482913' },
      { service: 'Delivery', patient, staff: null },
    );
    expect(d[0]!.body).toContain('482913');
  });
  it('assignment tells patient and staff; reassignment also tells the previous person', () => {
    const m = messagesFor('assigned', job, {
      service: 'Nursing visit',
      patient,
      staff: nurse,
      previousStaff: other,
    });
    expect(m.map((x) => [x.template, x.phone])).toEqual([
      ['assigned', '9876500000'],
      ['staff_assigned', '9100000001'],
      ['staff_unassigned', '9100000002'],
    ]);
    expect(m[1]!.body).toContain('Asha');
  });
  it('on the way includes the ETA when known', () => {
    expect(
      messagesFor('start', job, { service: 'x', patient, staff: nurse, etaMin: 18 })[0]!.body,
    ).toContain('arriving in about 18 min');
    expect(
      messagesFor('start', job, { service: 'x', patient, staff: nurse })[0]!.body,
    ).not.toContain('arriving');
  });
  it('cancellation tells both sides, arrival tells nobody', () => {
    expect(
      messagesFor(
        'cancel',
        { ...job, cancel_reason: 'feeling better' },
        { service: 'x', patient, staff: nurse },
      ).map((m) => m.template),
    ).toEqual(['cancelled', 'staff_cancelled']);
    expect(messagesFor('arrive', job, { service: 'x', patient, staff: nurse })).toEqual([]);
  });
});

describe('twilio provider', () => {
  it('normalizes Indian numbers', () => {
    expect(e164('98765 00000')).toBe('+919876500000');
    expect(e164('919876500000')).toBe('+919876500000');
    expect(e164('+447700900123')).toBe('+447700900123');
  });
  it('sends SMS and WhatsApp with basic auth and form encoding', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 }));
    const sms = twilioProvider({
      sid: 'AC1',
      token: 'tok',
      from: '+15550001111',
      channel: 'sms',
      fetchFn: f as unknown as typeof fetch,
    });
    expect(await sms.send('9876500000', 'hello')).toEqual({ ref: 'SM123' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Basic ' + Buffer.from('AC1:tok').toString('base64'),
    );
    const form = new URLSearchParams(String(init.body));
    expect(form.get('To')).toBe('+919876500000');
    expect(form.get('Body')).toBe('hello');
    const wa = twilioProvider({
      sid: 'AC1',
      token: 'tok',
      from: 'whatsapp:+15550001111',
      channel: 'whatsapp',
      fetchFn: f as unknown as typeof fetch,
    });
    await wa.send('9876500000', 'hi');
    expect(
      new URLSearchParams(
        String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body),
      ).get('To'),
    ).toBe('whatsapp:+919876500000');
  });
  it('surfaces provider errors', async () => {
    const f = async () => new Response(JSON.stringify({ message: 'invalid To' }), { status: 400 });
    await expect(
      twilioProvider({
        sid: 'a',
        token: 'b',
        from: '+1',
        channel: 'sms',
        fetchFn: f as unknown as typeof fetch,
      }).send('1', 'x'),
    ).rejects.toThrow(/invalid To/);
  });
});
