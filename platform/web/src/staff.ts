import { api, live, type Job, type User } from './api';
import { badge, h, here, localDay, on, rupees, time, toast } from './dom';

/**
 * Unsaved form input per job, so live refreshes (another job changing, an alert
 * firing) never wipe what a caregiver is typing.
 */
const drafts = new Map<string, string>();
/** Result of the last vitals save per job (alerts raised), kept across re-renders. */
const lastVitals = new Map<string, any[]>();
function keep<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  el: T,
  key: string,
): T {
  const saved = drafts.get(key);
  if (saved !== undefined) el.value = saved;
  el.addEventListener('input', () => drafts.set(key, el.value));
  el.addEventListener('change', () => drafts.set(key, el.value));
  return el;
}
const clearDrafts = (jobId: string) => {
  for (const k of [...drafts.keys()]) if (k.startsWith(`${jobId}:`)) drafts.delete(k);
};

/** Phone-first day view for caregivers and couriers. */
export function staffView(root: HTMLElement, user: User): () => void {
  const list = h('ol', { class: 'route', 'data-testid': 'route' });
  const dayInput = h('input', {
    type: 'date',
    value: localDay(),
    'aria-label': 'Day',
    'data-testid': 'day',
  });
  const summary = h('p', { class: 'fine' });
  const expanded = new Set<string>();

  const refresh = async () => {
    const jobs = await api<Job[]>('GET', `/api/staff/today?date=${dayInput.value}`);
    const open = jobs.filter((j) => !['completed', 'cancelled', 'no_show'].includes(j.status));
    summary.textContent = `${jobs.length} job(s), ${open.length} still to do.`;
    list.replaceChildren(
      ...(jobs.length
        ? jobs.map(card)
        : [h('li', { class: 'empty' }, 'Nothing scheduled for this day.')]),
    );
  };
  dayInput.addEventListener('change', () => void refresh());

  const act = async (j: Job, action: string, body: Record<string, unknown> = {}) => {
    const pos = ['start', 'arrive'].includes(action) ? await here() : null;
    await api('POST', `/api/jobs/${j.id}/actions/${action}`, { ...body, ...(pos ?? {}) });
    expanded.add(j.id);
    void refresh();
  };

  function card(j: Job): HTMLElement {
    const p = j['patient'];
    const isDelivery = j.kind === 'delivery';
    const maps =
      j['lat'] != null
        ? `https://www.google.com/maps/dir/?api=1&destination=${j['lat']},${j['lng']}`
        : null;
    const actions = h('div', { class: 'row' });
    const btn = (
      label: string,
      action: string,
      cls = 'primary',
      body?: () => Record<string, unknown> | null,
    ) =>
      on(
        h('button', { class: `btn ${cls}`, type: 'button', 'data-testid': `act-${action}` }, label),
        'click',
        async () => {
          const b = body ? body() : {};
          if (b === null) return;
          await act(j, action, b);
        },
      );
    const extra = h('div', { class: 'visit' });

    if (j.status === 'assigned' && j.kind !== 'clinic_visit')
      actions.append(btn('Start trip', 'start'));
    if (j.status === 'assigned' && j.kind === 'clinic_visit')
      actions.append(btn('Patient checked in', 'arrive'));
    if (j.status === 'en_route') actions.append(btn("I've arrived", 'arrive'));
    if (j.status === 'arrived' && !isDelivery) actions.append(btn('Begin visit', 'begin'));
    if (['arrived', 'in_progress'].includes(j.status)) {
      if (!isDelivery) extra.append(vitalsForm(j, () => void refresh()));
      extra.append(completeForm(j, (body) => act(j, 'complete', body)));
      actions.append(
        btn('Patient not available', 'no_show', 'ghost', () =>
          confirm('Mark as no-show?') ? { note: 'patient not available' } : null,
        ),
      );
    }

    const open = expanded.has(j.id) || ['en_route', 'arrived', 'in_progress'].includes(j.status);
    return h(
      'li',
      { class: `stop k-${j.kind}` },
      h(
        'details',
        { open: open || undefined },
        h(
          'summary',
          {},
          h('span', { class: 'time' }, time(j.starts_at)),
          h('strong', {}, p?.name ?? ''),
          ' · ',
          j['service'].name,
          ' ',
          badge(j.status),
        ),
        h(
          'p',
          {},
          j.kind === 'clinic_visit' ? `At ${j['site']?.name}` : j['address'],
          ' ',
          maps
            ? h(
                'a',
                { href: maps, target: '_blank', rel: 'noopener', class: 'btn small' },
                'Directions',
              )
            : null,
        ),
        p
          ? h('p', {}, h('a', { href: `tel:${p.phone}`, class: 'btn small' }, `Call ${p.phone}`))
          : null,
        p?.allergies?.length
          ? h('p', { class: 'allergy' }, '⚠ Allergies: ', p.allergies.join(', '))
          : null,
        p?.conditions?.length
          ? h('p', { class: 'fine' }, 'Conditions: ', p.conditions.join(', '))
          : null,
        isDelivery
          ? h(
              'ul',
              { class: 'items' },
              ...j['items'].map((i: any) => h('li', {}, `${i.qty} × ${i.name}`)),
            )
          : null,
        j['notes'] ? h('p', { class: 'notes' }, 'Patient notes: ', j['notes']) : null,
        p?.emergency_phone
          ? h(
              'p',
              { class: 'fine' },
              `Emergency contact: ${p.emergency_name ?? ''} ${p.emergency_phone}`,
            )
          : null,
        h(
          'p',
          { class: 'fine' },
          `To collect: ${rupees(j['price_paise'])} (${j['payment_status']})`,
        ),
        actions,
        extra,
      ),
    );
  }

  root.replaceChildren(
    h(
      'div',
      { class: 'page narrow' },
      h('h1', {}, 'My day'),
      h('div', { class: 'row' }, dayInput, summary),
      list,
    ),
  );
  void refresh();
  return live(() => void refresh());
}

const VITALS: [string, string, string, string?][] = [
  ['bp', 'BP systolic', 'mmHg', 'bp2'],
  ['hr', 'Heart rate', '/min'],
  ['spo2', 'SpO₂', '%'],
  ['glucose', 'Glucose', 'mg/dL'],
  ['temp', 'Temp', '°C'],
  ['rr', 'Resp. rate', '/min'],
  ['weight', 'Weight', 'kg'],
];

function vitalsForm(j: Job, done: () => void): HTMLElement {
  const inputs = new Map<string, HTMLInputElement>();
  const field = (code: string, label: string, unit: string) => {
    const i = keep(
      h('input', {
        type: 'number',
        step: 'any',
        inputmode: 'decimal',
        'aria-label': `${label} (${unit})`,
        placeholder: label,
        'data-testid': `v-${code}`,
      }),
      `${j.id}:v-${code}`,
    );
    inputs.set(code, i);
    return i;
  };
  const grid = h('div', { class: 'vitals-grid' });
  for (const [code, label, unit, second] of VITALS) {
    grid.append(h('label', {}, h('span', {}, `${label} (${unit})`), field(code, label, unit)));
    if (second)
      grid.append(
        h('label', {}, h('span', {}, 'BP diastolic (mmHg)'), field(second, 'BP diastolic', 'mmHg')),
      );
  }
  const out = h('div', { 'aria-live': 'polite' });
  const show = (alerts: any[]) =>
    out.replaceChildren(
      ...(alerts.length
        ? alerts.map((a) =>
            h(
              'p',
              { class: `alert ${a.severity}`, role: 'alert' },
              `${a.severity === 'critical' ? '🚨' : '⚠'} ${a.message}. The clinical team has been alerted.`,
            ),
          )
        : [h('p', { class: 'ok' }, 'Readings saved ✓')]),
    );
  // Survives re-renders, so the caregiver always sees what the last save triggered.
  const last = lastVitals.get(j.id);
  if (last) show(last);
  const save = on(
    h('button', { class: 'btn', type: 'button', 'data-testid': 'save-vitals' }, 'Save readings'),
    'click',
    async () => {
      const readings: any[] = [];
      for (const [code] of VITALS) {
        const v = inputs.get(code)!.value;
        if (!v) continue;
        const r: any = { code, value: Number(v) };
        if (code === 'bp') r.value2 = Number(inputs.get('bp2')!.value) || null;
        readings.push(r);
      }
      if (!readings.length) return toast('Enter at least one reading', true);
      const r = await api<{ alerts: any[] }>('POST', `/api/jobs/${j.id}/observations`, readings);
      for (const [code, i] of inputs) {
        i.value = '';
        drafts.delete(`${j.id}:v-${code}`);
      }
      lastVitals.set(j.id, r.alerts);
      show(r.alerts);
      done();
    },
  );
  return h('fieldset', {}, h('legend', {}, 'Vitals'), grid, save, out);
}

function completeForm(
  j: Job,
  submit: (body: Record<string, unknown>) => Promise<void>,
): HTMLElement {
  const isDelivery = j.kind === 'delivery';
  const notes = keep(
    h('textarea', {
      rows: '3',
      placeholder: isDelivery
        ? 'Delivery notes (optional)'
        : 'Visit notes: what you did, how the patient is, follow-up needed',
      'data-testid': 'visit-notes',
    }),
    `${j.id}:notes`,
  );
  const otp = keep(
    h('input', {
      inputmode: 'numeric',
      maxlength: '6',
      placeholder: '6-digit code from patient',
      'data-testid': 'otp-input',
    }),
    `${j.id}:otp`,
  );
  const pay = h(
    'select',
    { 'aria-label': 'Payment', 'data-testid': 'payment' },
    h('option', { value: '' }, 'Payment: not collected'),
    h('option', { value: 'cash' }, 'Paid cash'),
    h('option', { value: 'upi' }, 'Paid UPI'),
    h('option', { value: 'card' }, 'Paid card'),
    h('option', { value: 'insurance' }, 'Insurance'),
  );
  keep(pay, `${j.id}:pay`);
  if (j['payment_status'] === 'paid') pay.disabled = true;
  const btn = on(
    h(
      'button',
      { class: 'btn primary', type: 'button', 'data-testid': 'act-complete' },
      isDelivery ? 'Handed over' : 'Complete visit',
    ),
    'click',
    async () => {
      if (!isDelivery && j.status !== 'in_progress') return toast('Begin the visit first', true);
      await submit({
        ...(notes.value ? { visit_notes: notes.value } : {}),
        ...(isDelivery ? { otp: otp.value.trim() } : {}),
        ...(pay.value ? { payment_status: 'paid', payment_method: pay.value } : {}),
      });
      clearDrafts(j.id);
      toast('Done ✓');
    },
  );
  return h(
    'fieldset',
    {},
    h('legend', {}, isDelivery ? 'Handover' : 'Finish'),
    isDelivery ? otp : null,
    notes,
    pay,
    btn,
  );
}
