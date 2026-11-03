import { describe, expect, it, vi } from 'vitest';
import {
  fakePaymentProvider,
  invoicePdf,
  parsePaidEvent,
  razorpayProvider,
  renderPdf,
  signWebhook,
  verifyWebhookSignature,
} from '../src/payments.js';

describe('webhook signature', () => {
  const body = '{"event":"payment_link.paid"}';
  it('accepts the correct HMAC and rejects tampering, wrong secrets and missing headers', () => {
    const sig = signWebhook(body, 's3cret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(body, sig, 's3cret')).toBe(true);
    expect(verifyWebhookSignature(body + ' ', sig, 's3cret')).toBe(false);
    expect(verifyWebhookSignature(body, sig, 'other')).toBe(false);
    expect(verifyWebhookSignature(body, undefined, 's3cret')).toBe(false);
    expect(verifyWebhookSignature(body, sig, '')).toBe(false);
    expect(verifyWebhookSignature(body, 'abc', 's3cret')).toBe(false);
  });
  it('matches a known HMAC-SHA256 vector', () => {
    // RFC 4231 test case 2
    expect(signWebhook('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('paid event parsing', () => {
  it('extracts the fields we act on and ignores other events', () => {
    const ev = parsePaidEvent({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_1', reference_id: 'job_1', amount: 50000 } },
        payment: { entity: { id: 'pay_9', method: 'upi' } },
      },
    });
    expect(ev).toEqual({
      linkRef: 'plink_1',
      reference: 'job_1',
      amountPaise: 50000,
      method: 'upi',
      paymentRef: 'pay_9',
    });
    expect(parsePaidEvent({ event: 'payment.failed' })).toBeNull();
    expect(parsePaidEvent({ event: 'payment_link.paid', payload: {} })).toBeNull();
    expect(parsePaidEvent(null)).toBeNull();
  });
});

describe('providers', () => {
  it('razorpay sends an authenticated INR payment-link request', async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'plink_1', short_url: 'https://rzp.io/i/x' }), {
          status: 200,
        }),
    );
    const p = razorpayProvider({
      keyId: 'k',
      keySecret: 's',
      fetchFn: f as unknown as typeof fetch,
    });
    const r = await p.createLink({
      amountPaise: 50000,
      reference: 'job_1',
      description: 'Nursing',
      customer: { name: 'Asha', phone: '+919876500000' },
    });
    expect(r).toEqual({ ref: 'plink_1', url: 'https://rzp.io/i/x' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/payment_links');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Basic ' + Buffer.from('k:s').toString('base64'),
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      amount: 50000,
      currency: 'INR',
      reference_id: 'job_1',
    });
  });
  it('razorpay surfaces API errors', async () => {
    const f = async () =>
      new Response(JSON.stringify({ error: { description: 'bad key' } }), { status: 401 });
    const p = razorpayProvider({
      keyId: 'k',
      keySecret: 's',
      fetchFn: f as unknown as typeof fetch,
    });
    await expect(
      p.createLink({
        amountPaise: 1,
        reference: 'j',
        description: 'd',
        customer: { name: 'a', phone: '1' },
      }),
    ).rejects.toThrow(/401: bad key/);
  });
  it('the fake provider records requests', async () => {
    const p = fakePaymentProvider();
    const r = await p.createLink({
      amountPaise: 1,
      reference: 'j',
      description: 'd',
      customer: { name: 'a', phone: '1' },
    });
    expect(r.url).toContain('plink_fake1');
    expect(p.created).toHaveLength(1);
  });
});

describe('pdf', () => {
  it('produces a structurally valid PDF with correct xref offsets and escaped text', () => {
    const pdf = renderPdf([{ text: 'Hello (world) \\ ₹', right: 'Rs 1.00' }]).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('Hello \\(world\\) \\\\ ?');
    const start = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(start, start + 4)).toBe('xref');
    const offsets = [...pdf.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((o, i) =>
      expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`),
    );
  });
  it('distinguishes invoices from receipts', () => {
    const base = {
      number: 'X-1',
      issuedAt: '2026-11-03T00:00:00Z',
      patient: 'Asha',
      service: 'Nursing visit',
      serviceDate: '2026-11-04',
      amountPaise: 123456,
    };
    const inv = invoicePdf({ ...base, paid: false }).toString('latin1');
    const rec = invoicePdf({
      ...base,
      paid: true,
      paidAt: '2026-11-03T10:00:00Z',
      method: 'upi',
    }).toString('latin1');
    expect(inv).toContain('(Invoice)');
    expect(inv).toContain('Payment due');
    expect(rec).toContain('(Payment receipt)');
    expect(rec).toContain('PAID 2026-11-03 via upi');
    expect(rec).toContain('Rs 1,234.56');
  });
});
