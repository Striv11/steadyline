/**
 * Payments: Razorpay payment links behind a provider interface, webhook
 * signature verification, and minimal PDF invoices/receipts (no dependencies).
 *
 * Providers:
 *  - none (default): payment links are unavailable (501); cash/UPI at the door still works
 *  - razorpay: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
 *  - fake: for tests; returns deterministic links without any network call
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface LinkRequest {
  amountPaise: number;
  /** Our reference, echoed back in webhooks (the job id). */
  reference: string;
  description: string;
  customer: { name: string; phone: string };
}

export interface PaymentProvider {
  name: string;
  createLink(req: LinkRequest): Promise<{ ref: string; url: string }>;
}

export function fakePaymentProvider(): PaymentProvider & { created: LinkRequest[] } {
  const created: LinkRequest[] = [];
  return {
    name: 'fake',
    created,
    async createLink(req) {
      created.push(req);
      const ref = `plink_fake${created.length}`;
      return { ref, url: `https://pay.example.test/${ref}` };
    },
  };
}

export function razorpayProvider(opts: {
  keyId: string;
  keySecret: string;
  fetchFn?: typeof fetch;
}): PaymentProvider {
  const f = opts.fetchFn ?? fetch;
  return {
    name: 'razorpay',
    async createLink(req) {
      const res = await f('https://api.razorpay.com/v1/payment_links', {
        method: 'POST',
        headers: {
          authorization:
            'Basic ' + Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          amount: req.amountPaise,
          currency: 'INR',
          reference_id: req.reference,
          description: req.description,
          customer: { name: req.customer.name, contact: req.customer.phone },
          notify: { sms: false, email: false },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        short_url?: string;
        error?: { description?: string };
      };
      if (!res.ok || !data.id || !data.short_url)
        throw new Error(`razorpay ${res.status}: ${data.error?.description ?? 'link failed'}`);
      return { ref: data.id, url: data.short_url };
    },
  };
}

export function paymentProviderFromEnv(env = process.env): PaymentProvider | null {
  const keyId = env['RAZORPAY_KEY_ID'];
  const keySecret = env['RAZORPAY_KEY_SECRET'];
  return keyId && keySecret ? razorpayProvider({ keyId, keySecret }) : null;
}

/** Razorpay signs the exact raw request body: hex HMAC-SHA256 with the webhook secret. */
export function signWebhook(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const a = Buffer.from(signWebhook(rawBody, secret));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What a webhook tells us, reduced to the fields we act on; null if it is not a payment-link event. */
export interface PaidEvent {
  linkRef: string;
  reference: string;
  amountPaise: number;
  method: string | null;
  paymentRef: string | null;
}

export function parsePaidEvent(body: unknown): PaidEvent | null {
  const b = body as {
    event?: string;
    payload?: {
      payment_link?: { entity?: { id?: string; reference_id?: string; amount?: number } };
      payment?: { entity?: { id?: string; method?: string } };
    };
  };
  if (b?.event !== 'payment_link.paid') return null;
  const link = b.payload?.payment_link?.entity;
  if (!link?.id || !link.reference_id || typeof link.amount !== 'number') return null;
  return {
    linkRef: link.id,
    reference: link.reference_id,
    amountPaise: link.amount,
    method: b.payload?.payment?.entity?.method ?? null,
    paymentRef: b.payload?.payment?.entity?.id ?? null,
  };
}

// ---------- PDF ----------

export interface DocLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Right-aligned column text on the same baseline (e.g. an amount). */
  right?: string;
}

const esc = (s: string) =>
  // WinAnsi-safe: replace anything outside Latin-1 (e.g. the rupee sign is written as "Rs").
  s
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

/** Approximate Helvetica width (0.5em average) to right-align without font metrics. */
const width = (s: string, size: number) => s.length * size * 0.5;

/** A one-page A4 PDF of text lines. Valid per ISO 32000 with the built-in Helvetica fonts. */
export function renderPdf(lines: DocLine[]): Buffer {
  let y = 800;
  const ops: string[] = [];
  for (const l of lines) {
    const size = l.size ?? 11;
    y -= size * 1.7;
    const font = l.bold ? '/F2' : '/F1';
    ops.push(`BT ${font} ${size} Tf 50 ${y.toFixed(1)} Td (${esc(l.text)}) Tj ET`);
    if (l.right) {
      const x = 545 - width(l.right, size);
      ops.push(`BT ${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(l.right)}) Tj ET`);
    }
  }
  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const rs = (paise: number) =>
  'Rs ' +
  (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface DocData {
  number: string;
  issuedAt: string;
  patient: string;
  service: string;
  serviceDate: string;
  amountPaise: number;
  paid: boolean;
  paidAt?: string | null;
  method?: string | null;
  reference?: string | null;
}

export function invoicePdf(d: DocData): Buffer {
  const receipt = d.paid;
  return renderPdf([
    { text: 'Steadyline Care', size: 20, bold: true },
    { text: receipt ? 'Payment receipt' : 'Invoice', size: 14, bold: true },
    { text: '' },
    { text: `${receipt ? 'Receipt' : 'Invoice'} no: ${d.number}` },
    { text: `Issued: ${d.issuedAt.slice(0, 10)}` },
    { text: `Billed to: ${d.patient}` },
    { text: '' },
    { text: 'Description', bold: true, right: 'Amount' },
    { text: `${d.service} on ${d.serviceDate}`, right: rs(d.amountPaise) },
    { text: '' },
    { text: 'Total', bold: true, right: rs(d.amountPaise) },
    { text: '' },
    receipt
      ? {
          text: `PAID ${d.paidAt?.slice(0, 10) ?? ''}${d.method ? ' via ' + d.method : ''}${d.reference ? ' (ref ' + d.reference + ')' : ''}`,
          bold: true,
        }
      : { text: 'Payment due. Pay by the link sent to you, or in cash/UPI to your caregiver.' },
    { text: '' },
    {
      text: 'This document is not a medical record. Taxes, if applicable, are not itemised.',
      size: 8,
    },
  ]);
}
