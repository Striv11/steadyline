import { api, ApiError, live, openPdf, type Job, type User } from './api';
import { badge, h, here, localDay, on, rupees, toast, when } from './dom';

interface Service {
  id: string;
  name: string;
  kind: Job['kind'];
  duration_min: number;
  price_paise: number;
  description: string;
}

const VITAL_LABEL: Record<string, string> = {
  bp: 'Blood pressure',
  glucose: 'Glucose',
  spo2: 'SpO₂',
  hr: 'Heart rate',
  temp: 'Temperature',
  rr: 'Respiration',
  weight: 'Weight',
};

export function patientView(root: HTMLElement, user: User): () => void {
  const bookings = h('section', {
    class: 'card',
    'aria-labelledby': 'b-h',
    'data-testid': 'bookings',
  });
  const vitals = h('section', { class: 'card', 'aria-labelledby': 'v-h' });
  const book = h('section', { class: 'card', 'aria-labelledby': 'n-h' });
  const profile = h('section', { class: 'card', 'aria-labelledby': 'p-h' });
  const plans = h('section', {
    class: 'card',
    'aria-labelledby': 'cp-h',
    'data-testid': 'care-plans',
  });

  const refresh = async () => {
    const [jobs, obs, prof] = await Promise.all([
      api<Job[]>('GET', '/api/jobs'),
      api<any[]>('GET', '/api/patient/observations'),
      api<any>('GET', '/api/patient/profile'),
    ]);
    drawBookings(jobs.reverse());
    drawVitals(obs);
    if (!profile.dataset['drawn']) drawProfile(prof);
    drawBook(prof);
    void drawPlans();
  };

  const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const describeRule = (rule: string) => {
    const m = new Map(rule.split(';').map((x) => x.split('=') as [string, string]));
    const n = Number(m.get('INTERVAL') ?? 1);
    if (m.get('FREQ') === 'DAILY') return n === 1 ? 'Every day' : `Every ${n} days`;
    const days = (m.get('BYDAY') ?? '').split(',').join(', ');
    return `${n === 1 ? 'Every week' : `Every ${n} weeks`}${days ? ` on ${days}` : ''}`;
  };

  async function drawPlans() {
    const list = await api<any[]>('GET', '/api/care-plans');
    const services = await api<Service[]>('GET', '/api/services');
    const homeServices = services.filter((s) => s.kind === 'home_visit');

    const cards = list
      .filter((p) => p.active)
      .map((p) =>
        h(
          'div',
          { class: 'job', 'data-testid': 'care-plan' },
          h('strong', {}, p.service_name),
          h('p', { class: 'fine' }, `${describeRule(p.rule)} at ${p.time_of_day}`),
          h(
            'ul',
            { class: 'plain' },
            ...p.upcoming.slice(0, 4).map((u: any) =>
              h(
                'li',
                {},
                u.skipped
                  ? h('s', {}, when(`${u.date}T12:00:00Z`).split(',')[0]!)
                  : when(u.starts_at),
                u.skipped ? ' skipped ' : u.modified ? ' (changed) ' : ' ',
                on(
                  h('button', { class: 'link', type: 'button' }, u.skipped ? 'Restore' : 'Skip'),
                  'click',
                  async () => {
                    await api('POST', `/api/care-plans/${p.id}/occurrences/${u.date}`, {
                      action: u.skipped ? 'restore' : 'skip',
                    });
                    toast(u.skipped ? 'Visit restored.' : 'Visit skipped.');
                    void drawPlans();
                  },
                ),
                u.skipped
                  ? null
                  : on(
                      h('button', { class: 'link', type: 'button' }, 'Change time'),
                      'click',
                      async () => {
                        const tm = prompt(
                          'New time for this visit (HH:MM, 24-hour)',
                          p.time_of_day,
                        );
                        if (!tm) return;
                        await api('POST', `/api/care-plans/${p.id}/occurrences/${u.date}`, {
                          action: 'modify',
                          time_of_day: tm,
                        });
                        toast('Visit time changed.');
                        void drawPlans();
                      },
                    ),
              ),
            ),
          ),
          on(
            h('button', { class: 'btn ghost', type: 'button' }, 'End this plan'),
            'click',
            async () => {
              if (!confirm('End this plan and cancel its upcoming visits?')) return;
              const r = await api('POST', `/api/care-plans/${p.id}/end`);
              toast(`Plan ended. ${r.cancelled_jobs} visits cancelled.`);
              void drawPlans();
            },
          ),
        ),
      );

    const svc = h(
      'select',
      { id: 'cp-svc', 'aria-label': 'Service' },
      ...homeServices.map((s) => h('option', { value: s.id }, s.name)),
    );
    const freq = h(
      'select',
      { id: 'cp-freq', 'aria-label': 'Repeat' },
      h('option', { value: 'DAILY' }, 'Every day'),
      h('option', { value: 'WEEKLY', selected: true }, 'Every week'),
    );
    const days = DAY_CODES.map((d, i) =>
      h(
        'label',
        { class: 'chk' },
        h('input', {
          type: 'checkbox',
          value: d,
          ...(i === new Date().getDay() - 1 ? { checked: true } : {}),
        }),
        d,
      ),
    );
    const start = h('input', {
      id: 'cp-start',
      type: 'date',
      value: localDay(new Date(Date.now() + 86_400_000)),
    });
    const tod = h('input', { id: 'cp-time', type: 'time', value: '09:00' });
    const form = on(
      h(
        'form',
        { class: 'stack', 'data-testid': 'care-plan-form' },
        h('label', { for: 'cp-svc' }, 'Service'),
        svc,
        h('label', { for: 'cp-freq' }, 'Repeat'),
        freq,
        h('div', { class: 'row', role: 'group', 'aria-label': 'Weekdays (weekly only)' }, ...days),
        h('label', { for: 'cp-start' }, 'Starting'),
        start,
        h('label', { for: 'cp-time' }, 'Time'),
        tod,
        h('button', { class: 'btn', type: 'submit' }, 'Start plan'),
      ),
      'submit',
      async (e) => {
        e.preventDefault();
        const picked = days
          .map((l) => l.querySelector('input')!)
          .filter((i) => i.checked)
          .map((i) => i.value);
        if (freq.value === 'WEEKLY' && !picked.length)
          throw new Error('Pick at least one weekday.');
        const rule =
          freq.value === 'DAILY' ? 'FREQ=DAILY' : `FREQ=WEEKLY;BYDAY=${picked.join(',')}`;
        const r = await api('POST', '/api/care-plans', {
          service_id: svc.value,
          rule,
          start_date: start.value,
          time_of_day: tod.value,
        });
        toast(`Plan started. ${r.generated.created.length} visits scheduled.`);
        void refresh();
      },
    );
    plans.replaceChildren(
      h('h2', { id: 'cp-h' }, 'Repeating visits'),
      ...(cards.length ? cards : [h('p', { class: 'fine' }, 'No repeating plans yet.')]),
      ...(homeServices.length
        ? [h('details', {}, h('summary', {}, 'Set up a repeating visit'), form)]
        : []),
    );
  }

  function drawBookings(jobs: Job[]) {
    const open = jobs.filter((j) => !['completed', 'cancelled', 'no_show'].includes(j.status));
    const past = jobs.filter((j) => !open.includes(j));
    const card = (j: Job) => {
      const actions = h('div', { class: 'row' });
      if (['requested', 'assigned'].includes(j.status))
        actions.append(
          on(h('button', { class: 'btn ghost', type: 'button' }, 'Cancel'), 'click', async () => {
            if (!confirm('Cancel this booking?')) return;
            await api('POST', `/api/jobs/${j.id}/actions/cancel`, {
              reason: 'cancelled by patient',
            });
            toast('Booking cancelled');
            void refresh();
          }),
        );
      if (j.status !== 'cancelled') {
        const settled = j['payment_status'] !== 'unpaid';
        if (!settled && j['price_paise'] > 0)
          actions.append(
            on(h('button', { class: 'btn', type: 'button' }, 'Pay online'), 'click', async () => {
              try {
                const r = await api<{ url: string }>('POST', `/api/jobs/${j.id}/payment-link`);
                window.open(r.url, '_blank', 'noopener');
              } catch (e) {
                toast(
                  (e as ApiError).status === 501
                    ? 'Online payment is not available yet. Pay your caregiver directly.'
                    : (e as Error).message,
                );
              }
            }),
          );
        actions.append(
          on(
            h('button', { class: 'btn ghost', type: 'button' }, settled ? 'Receipt' : 'Invoice'),
            'click',
            () =>
              void openPdf(`/api/jobs/${j.id}/invoice.pdf`).catch((e) => toast(String(e.message))),
          ),
        );
      }
      if (j.status === 'completed' && !j['rating']) {
        for (let r = 5; r >= 1; r--)
          actions.append(
            on(
              h(
                'button',
                { class: 'btn star', type: 'button', 'aria-label': `Rate ${r} of 5` },
                '★'.repeat(r),
              ),
              'click',
              async () => {
                await api('POST', `/api/jobs/${j.id}/rating`, { rating: r });
                toast('Thank you for rating');
                void refresh();
              },
            ),
          );
      }
      return h(
        'li',
        { class: 'job' },
        h('div', { class: 'job-head' }, h('strong', {}, j['service'].name), badge(j.status)),
        h(
          'p',
          { class: 'meta' },
          when(j.starts_at),
          ' · ',
          j.kind === 'clinic_visit' ? j['site']?.name : j['address'],
          ' · ',
          rupees(j['price_paise']),
        ),
        j['staff']
          ? h(
              'p',
              {},
              `${j['staff'].name} · `,
              h('a', { href: `tel:${j['staff'].phone}` }, j['staff'].phone),
            )
          : null,
        j['eta_min'] != null
          ? h(
              'p',
              { class: 'eta', 'data-testid': 'eta' },
              `🚗 Arriving in about ${j['eta_min']} min`,
            )
          : null,
        j.status === 'requested'
          ? h(
              'p',
              { class: 'fine' },
              'We are finding the right person; you will see their name here.',
            )
          : null,
        j['otp_code'] && j.status !== 'completed'
          ? h(
              'p',
              { class: 'otp', 'data-testid': 'otp' },
              'Delivery code: ',
              h('strong', {}, j['otp_code']),
              h(
                'span',
                { class: 'fine' },
                ' Give it to the courier only when you receive your items.',
              ),
            )
          : null,
        j['visit_notes'] ? h('p', { class: 'notes' }, 'Visit notes: ', j['visit_notes']) : null,
        actions,
      );
    };
    bookings.replaceChildren(
      h('h2', { id: 'b-h' }, 'My bookings'),
      open.length
        ? h('ul', { class: 'jobs' }, ...open.map(card))
        : h('p', { class: 'empty' }, 'No upcoming bookings.'),
      ...(past.length
        ? [
            h(
              'details',
              {},
              h('summary', {}, `Past (${past.length})`),
              h('ul', { class: 'jobs' }, ...past.map(card)),
            ),
          ]
        : []),
    );
  }

  function drawVitals(obs: any[]) {
    if (!obs.length) {
      vitals.replaceChildren(
        h('h2', { id: 'v-h' }, 'My readings'),
        h('p', { class: 'empty' }, 'Readings taken at your visits will appear here.'),
      );
      return;
    }
    const byCode = new Map<string, any[]>();
    for (const o of obs) byCode.set(o.code, [...(byCode.get(o.code) ?? []), o]);
    vitals.replaceChildren(
      h('h2', { id: 'v-h' }, 'My readings'),
      h(
        'table',
        { class: 'table', 'data-testid': 'vitals' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Measure'),
            h('th', {}, 'Latest'),
            h('th', {}, 'When'),
            h('th', {}, 'Trend'),
          ),
        ),
        h(
          'tbody',
          {},
          ...[...byCode].map(([code, list]) => {
            const last = list.at(-1);
            return h(
              'tr',
              {},
              h('td', {}, VITAL_LABEL[code] ?? code),
              h('td', {}, `${last.value}${last.value2 ? '/' + last.value2 : ''} ${last.unit}`),
              h('td', {}, when(last.recorded_at)),
              h('td', {}, spark(list.map((o) => o.value))),
            );
          }),
        ),
      ),
    );
  }

  function drawProfile(p: any) {
    profile.dataset['drawn'] = '1';
    const f = (id: string, label: string, value: string, attrs: Record<string, string> = {}) => {
      const input = h('input', { id, value: value ?? '', ...attrs });
      return { input, el: h('div', { class: 'field' }, h('label', { for: id }, label), input) };
    };
    const address = f('addr', 'Home address (for visits and deliveries)', p.address, {
      'data-testid': 'address',
    });
    const conditions = f('cond', 'Conditions (comma separated)', (p.conditions ?? []).join(', '));
    const allergies = f('allergy', 'Allergies (comma separated)', (p.allergies ?? []).join(', '));
    const ename = f('ename', 'Emergency contact name', p.emergency_name ?? '');
    const ephone = f('ephone', 'Emergency contact phone', p.emergency_phone ?? '', { type: 'tel' });
    let coords: { lat: number; lng: number } | null =
      p.lat != null ? { lat: p.lat, lng: p.lng } : null;
    const locNote = h(
      'span',
      { class: 'fine', 'data-testid': 'loc-note' },
      coords ? 'Location saved ✓' : 'Location not set',
    );
    const locBtn = on(
      h(
        'button',
        { class: 'btn', type: 'button', 'data-testid': 'use-location' },
        '📍 Use my current location',
      ),
      'click',
      async () => {
        locNote.textContent = 'Locating…';
        coords = await here();
        locNote.textContent = coords
          ? 'Location captured ✓ (save to keep it)'
          : 'Could not get your location; allow location access and try again.';
      },
    );
    const save = on(
      h(
        'button',
        { class: 'btn primary', type: 'submit', 'data-testid': 'save-profile' },
        'Save profile',
      ),
      'click',
      async (e) => {
        e.preventDefault();
        const list = (s: string) =>
          s
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        await api('PUT', '/api/patient/profile', {
          address: address.input.value,
          conditions: list(conditions.input.value),
          allergies: list(allergies.input.value),
          ...(ename.input.value ? { emergency_name: ename.input.value } : {}),
          ...(ephone.input.value ? { emergency_phone: ephone.input.value.replace(/\s/g, '') } : {}),
          ...(coords ? coords : {}),
        });
        toast('Profile saved');
        void refresh();
      },
    );
    profile.replaceChildren(
      h(
        'details',
        { open: !p.address || p.lat == null ? true : undefined },
        h('summary', { id: 'p-h' }, 'My profile & address'),
        h(
          'form',
          { class: 'grid2' },
          address.el,
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'label' }, 'Map location'),
            h('div', { class: 'row' }, locBtn, locNote),
          ),
          conditions.el,
          allergies.el,
          ename.el,
          ephone.el,
          h('div', {}, save),
        ),
      ),
    );
  }

  async function drawBook(p: any) {
    if (book.dataset['drawn']) return;
    book.dataset['drawn'] = '1';
    const [services, sites] = await Promise.all([
      api<Service[]>('GET', '/api/services'),
      api<any[]>('GET', '/api/sites'),
    ]);
    const svc = h(
      'select',
      { id: 'svc', 'data-testid': 'service' },
      ...services.map((s) => h('option', { value: s.id }, `${s.name} · ${rupees(s.price_paise)}`)),
    );
    const desc = h('p', { class: 'fine' });
    const date = h('input', { id: 'when', type: 'datetime-local', 'data-testid': 'when' });
    const t = new Date(Date.now() + 3 * 3600_000);
    t.setMinutes(0, 0, 0);
    date.value = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const site = h(
      'select',
      { id: 'site' },
      ...sites
        .filter((s) => s.kind === 'clinic')
        .map((s) => h('option', { value: s.id }, `${s.name}, ${s.address}`)),
    );
    const siteRow = h('div', { class: 'field' }, h('label', { for: 'site' }, 'Clinic'), site);
    const items = h('textarea', {
      id: 'items',
      rows: '3',
      placeholder: 'One per line, e.g.\nMetformin 500 mg x2\nGlucometer strips x1',
      'data-testid': 'items',
    });
    const itemsRow = h(
      'div',
      { class: 'field' },
      h('label', { for: 'items' }, 'Items to deliver'),
      items,
    );
    const notes = h('textarea', {
      id: 'notes',
      rows: '2',
      placeholder: 'Anything the caregiver should know (gate code, floor, symptoms)',
    });
    const sync = () => {
      const s = services.find((x) => x.id === svc.value)!;
      desc.textContent = `${s.description} About ${s.duration_min} min.`;
      siteRow.hidden = s.kind !== 'clinic_visit';
      itemsRow.hidden = s.kind !== 'delivery';
    };
    svc.addEventListener('change', sync);
    sync();
    const form = h(
      'form',
      {},
      h('h2', { id: 'n-h' }, 'Book care'),
      h('div', { class: 'field' }, h('label', { for: 'svc' }, 'What do you need?'), svc, desc),
      h('div', { class: 'field' }, h('label', { for: 'when' }, 'When'), date),
      siteRow,
      itemsRow,
      h('div', { class: 'field' }, h('label', { for: 'notes' }, 'Notes'), notes),
      h('button', { class: 'btn primary', type: 'submit', 'data-testid': 'book' }, 'Book'),
      !p.address || p.lat == null
        ? h(
            'p',
            { class: 'fine' },
            'Add your address and location in your profile before booking a home visit or delivery.',
          )
        : null,
    );
    on(form, 'submit', async (e) => {
      e.preventDefault();
      const s = services.find((x) => x.id === svc.value)!;
      const r = await api<{ job: Job; dispatch: any }>('POST', '/api/jobs', {
        service_id: s.id,
        starts_at: new Date(date.value).toISOString(),
        notes: notes.value,
        ...(s.kind === 'clinic_visit' ? { site_id: site.value } : {}),
        ...(s.kind === 'delivery'
          ? {
              items: items.value
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .map((l) => {
                  const m = l.match(/^(.*?)\s*x\s*(\d+)$/i);
                  return m ? { name: m[1]!, qty: Number(m[2]) } : { name: l, qty: 1 };
                }),
            }
          : {}),
      });
      toast(
        r.dispatch.assigned
          ? `Booked. ${r.dispatch.assigned.name} will come.`
          : 'Booked. We are finding the right person.',
      );
      notes.value = '';
      items.value = '';
      void refresh();
    });
    book.replaceChildren(form);
  }

  root.replaceChildren(
    h(
      'div',
      { class: 'page' },
      h('h1', {}, `Hello, ${user.name.split(' ')[0]}`),
      h(
        'div',
        { class: 'cols' },
        h('div', {}, book, plans, profile),
        h('div', {}, bookings, vitals),
      ),
    ),
  );
  void refresh();
  return live(() => void refresh());
}

function spark(values: number[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  if (values.length < 2) return svg;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${22 - ((v - lo) / (hi - lo || 1)) * 20}`)
    .join(' ');
  const pl = document.createElementNS(ns, 'polyline');
  pl.setAttribute('points', pts);
  svg.append(pl);
  return svg;
}
