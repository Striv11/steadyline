import { api, live, type Job, type User } from './api';
import { badge, h, localDay, on, rupees, time, toast, when } from './dom';

/** Dispatch board, alerts, roster, patients, admin. */
export function opsView(root: HTMLElement, user: User): () => void {
  const tabs = [
    'Board',
    'Alerts',
    'Patients',
    'Staff',
    ...(user.role === 'admin' ? ['Setup', 'Audit'] : []),
  ];
  let tab = 'Board';
  const dayInput = h('input', {
    type: 'date',
    value: localDay(),
    'aria-label': 'Day',
    'data-testid': 'ops-day',
  });
  const body = h('div', {});
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const alertCount = h('span', { class: 'count' });

  const drawTabs = () =>
    tabBar.replaceChildren(
      ...tabs.map((t) =>
        on(
          h(
            'button',
            {
              role: 'tab',
              'aria-selected': String(t === tab),
              class: 'tab',
              type: 'button',
              'data-testid': `tab-${t.toLowerCase()}`,
            },
            t,
            t === 'Alerts' ? alertCount : null,
          ),
          'click',
          () => {
            tab = t;
            drawTabs();
            void refresh();
          },
        ),
      ),
    );

  const refresh = async () => {
    const alerts = await api<any[]>('GET', '/api/ops/alerts');
    alertCount.textContent = alerts.length ? ` ${alerts.length}` : '';
    alertCount.className = alerts.some((a) => a.severity === 'critical')
      ? 'count critical'
      : 'count';
    if (tab === 'Board') body.replaceChildren(await board());
    if (tab === 'Alerts') body.replaceChildren(alertsView(alerts, refresh));
    if (tab === 'Patients') body.replaceChildren(await patientsView());
    if (tab === 'Staff') body.replaceChildren(await staffAdmin(user, dayInput.value, refresh));
    if (tab === 'Audit') body.replaceChildren(await auditView());
    if (tab === 'Setup') body.replaceChildren(await setupView(refresh));
  };
  dayInput.addEventListener('change', () => void refresh());

  async function board(): Promise<HTMLElement> {
    const b = await api<any>('GET', `/api/ops/board?date=${dayInput.value}`);
    const m = await api<any>('GET', '/api/ops/metrics');
    const queue = b.jobs.filter((j: Job) => j.status === 'requested');
    const rest = b.jobs.filter((j: Job) => j.status !== 'requested');
    const kpi = (label: string, value: string, id?: string) =>
      h(
        'div',
        { class: 'kpi' },
        h('span', { class: 'v', ...(id ? { 'data-testid': id } : {}) }, value),
        h('span', {}, label),
      );
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'kpis' },
        kpi('Unassigned', String(queue.length), 'kpi-queue'),
        kpi(
          'Active now',
          String(
            rest.filter((j: Job) => ['en_route', 'arrived', 'in_progress'].includes(j.status))
              .length,
          ),
        ),
        kpi('Completed', String(b.counts.completed ?? 0)),
        kpi('Open alerts', String(b.open_alerts)),
        kpi(
          'On-time arrival',
          m.on_time_rate == null ? '–' : `${Math.round(m.on_time_rate * 100)}%`,
        ),
        kpi('Collected', rupees(m.revenue_paid_paise)),
      ),
      h('h2', {}, `Needs staff (${queue.length})`),
      queue.length
        ? h('ul', { class: 'jobs', 'data-testid': 'queue' }, ...queue.map((j: Job) => queueCard(j)))
        : h('p', { class: 'empty' }, 'Every job is staffed.'),
      h('h2', {}, `Schedule · ${dayInput.value}`),
      h(
        'table',
        { class: 'table', 'data-testid': 'schedule' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...['Time', 'Patient', 'Service', 'Where', 'Staff', 'Status', ''].map((x) =>
              h('th', {}, x),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          ...rest.map((j: Job) =>
            h(
              'tr',
              {},
              h('td', {}, time(j.starts_at)),
              h('td', {}, j['patient'].name),
              h('td', {}, j['service'].name),
              h('td', {}, j.kind === 'clinic_visit' ? j['site']?.name : j['address']),
              h('td', {}, j['staff']?.name ?? '–'),
              h('td', {}, badge(j.status)),
              h('td', {}, ['assigned', 'requested'].includes(j.status) ? reassign(j) : null),
            ),
          ),
        ),
      ),
      h('h2', {}, 'Team today'),
      h(
        'table',
        { class: 'table' },
        h(
          'thead',
          {},
          h('tr', {}, ...['Name', 'Role', 'Skills', 'Jobs', 'On shift'].map((x) => h('th', {}, x))),
        ),
        h(
          'tbody',
          {},
          ...b.staff.map((s: any) =>
            h(
              'tr',
              {},
              h('td', {}, s.name),
              h('td', {}, s.role),
              h('td', {}, s.skills.join(', ')),
              h('td', {}, s.jobs_today),
              h('td', {}, s.on_shift ? 'yes' : 'no'),
            ),
          ),
        ),
      ),
      bookForPatient(refresh),
    );
  }

  function queueCard(j: Job): HTMLElement {
    const out = h('div', { class: 'cands' });
    return h(
      'li',
      { class: 'job' },
      h(
        'div',
        { class: 'job-head' },
        h('strong', {}, `${j['service'].name} · ${j['patient'].name}`),
        badge(j.status),
      ),
      h('p', { class: 'meta' }, when(j.starts_at), ' · ', j['address']),
      h(
        'div',
        { class: 'row' },
        on(
          h(
            'button',
            { class: 'btn primary', type: 'button', 'data-testid': 'auto-assign' },
            'Auto-assign',
          ),
          'click',
          async () => {
            const r = await api<any>('POST', `/api/jobs/${j.id}/auto-assign`);
            toast(
              r.assigned
                ? `Assigned to ${r.assigned.name}`
                : 'Still nobody eligible; see reasons or assign manually',
              !r.assigned,
            );
            void refresh();
          },
        ),
        on(h('button', { class: 'btn', type: 'button' }, 'Why nobody?'), 'click', async () => {
          const c = await api<any>('GET', `/api/jobs/${j.id}/candidates`);
          out.replaceChildren(
            h(
              'ul',
              { class: 'fine' },
              ...c.rejected.map((x: any) => h('li', {}, `${x.name}: ${x.reason}`)),
            ),
          );
        }),
        reassign(j),
        on(h('button', { class: 'btn ghost', type: 'button' }, 'Cancel'), 'click', async () => {
          const reason = prompt('Reason for cancelling (the patient will see this)?');
          if (!reason) return;
          await api('POST', `/api/jobs/${j.id}/actions/cancel`, { reason });
          void refresh();
        }),
      ),
      out,
    );
  }

  function reassign(j: Job): HTMLElement {
    const sel = h(
      'select',
      { 'aria-label': 'Assign to', class: 'small' },
      h('option', { value: '' }, j.status === 'requested' ? 'Assign to…' : 'Reassign…'),
    );
    sel.addEventListener('focus', async () => {
      if (sel.options.length > 1) return;
      const c = await api<any>('GET', `/api/jobs/${j.id}/candidates`);
      for (const e of c.eligible)
        sel.append(h('option', { value: e.id }, `${e.name} (${e.reason})`));
      for (const r of c.rejected)
        if (r.id !== '-') sel.append(h('option', { value: r.id }, `⚠ ${r.name}: ${r.reason}`));
    });
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      try {
        await api('POST', `/api/jobs/${j.id}/actions/assign`, { staff_id: sel.value });
        toast('Assigned');
      } catch (e) {
        toast((e as Error).message, true);
      }
      void refresh();
    });
    return sel;
  }

  root.replaceChildren(
    h(
      'div',
      { class: 'page wide' },
      h('div', { class: 'row spread' }, h('h1', {}, 'Operations'), dayInput),
      tabBar,
      body,
    ),
  );
  drawTabs();
  void refresh();
  return live(() => void refresh());
}

function alertsView(alerts: any[], refresh: () => Promise<void>): HTMLElement {
  if (!alerts.length)
    return h('p', { class: 'empty', 'data-testid': 'no-alerts' }, 'No open alerts.');
  return h(
    'ul',
    { class: 'jobs', 'data-testid': 'alerts' },
    ...alerts.map((a) => {
      const res = h('input', {
        placeholder: 'What did you do? (e.g. called patient, doctor informed)',
        'data-testid': 'ack-text',
      });
      return h(
        'li',
        { class: `job alert-card ${a.severity}` },
        h(
          'div',
          { class: 'job-head' },
          h('strong', {}, `${a.severity === 'critical' ? '🚨' : '⚠'} ${a.patient_name}`),
          h('span', { class: 'fine' }, when(a.created_at)),
        ),
        h('p', {}, a.message),
        h(
          'p',
          {},
          h('a', { href: `tel:${a.patient_phone}`, class: 'btn small' }, `Call ${a.patient_phone}`),
        ),
        h(
          'div',
          { class: 'row' },
          res,
          on(
            h('button', { class: 'btn primary', type: 'button', 'data-testid': 'ack' }, 'Resolve'),
            'click',
            async () => {
              await api('POST', `/api/ops/alerts/${a.id}/ack`, { resolution: res.value });
              toast('Alert resolved');
              void refresh();
            },
          ),
        ),
      );
    }),
  );
}

async function patientsView(): Promise<HTMLElement> {
  const q = h('input', {
    type: 'search',
    placeholder: 'Search name or phone',
    'aria-label': 'Search patients',
  });
  const list = h('ul', { class: 'jobs' });
  const detail = h('div', {});
  const search = async () => {
    const rows = await api<any[]>('GET', `/api/ops/patients?q=${encodeURIComponent(q.value)}`);
    list.replaceChildren(
      ...rows.map((p) =>
        h(
          'li',
          { class: 'job' },
          on(
            h('button', { class: 'btn link', type: 'button' }, `${p.name} · ${p.phone}`),
            'click',
            async () => {
              const r = await api<any>('GET', `/api/ops/patients/${p.id}`);
              detail.replaceChildren(
                h('h2', {}, r.profile.name),
                h('p', {}, r.profile.address || 'No address'),
                h(
                  'p',
                  { class: 'fine' },
                  `Conditions: ${r.profile.conditions.join(', ') || '–'} · Allergies: ${r.profile.allergies.join(', ') || 'none recorded'}`,
                ),
                h('h3', {}, 'Recent readings'),
                h(
                  'ul',
                  {},
                  ...r.observations
                    .slice(-15)
                    .reverse()
                    .map((o: any) =>
                      h(
                        'li',
                        {},
                        `${when(o.recorded_at)} · ${o.code} ${o.value}${o.value2 ? '/' + o.value2 : ''} ${o.unit}`,
                      ),
                    ),
                ),
                h('h3', {}, 'Visits'),
                h(
                  'ul',
                  {},
                  ...r.jobs.map((j: Job) =>
                    h(
                      'li',
                      {},
                      `${when(j.starts_at)} · ${j['service'].name} · `,
                      badge(j.status),
                      j['visit_notes'] ? ` · ${j['visit_notes']}` : '',
                    ),
                  ),
                ),
              );
            },
          ),
          h('span', { class: 'fine' }, ` ${JSON.parse(p.conditions).join(', ')}`),
        ),
      ),
    );
  };
  q.addEventListener('input', () => void search());
  void search();
  return h('div', { class: 'cols' }, h('div', {}, q, list), detail);
}

async function staffAdmin(
  user: User,
  day: string,
  refresh: () => Promise<void>,
): Promise<HTMLElement> {
  const b = await api<any>('GET', `/api/ops/board?date=${day}`);
  const shifts = await api<any[]>('GET', `/api/ops/shifts?date=${day}`);
  const staffSel = h(
    'select',
    { 'aria-label': 'Staff member' },
    ...b.staff.map((s: any) => h('option', { value: s.id }, s.name)),
  );
  const from = h('input', { type: 'time', value: '08:00', 'aria-label': 'Shift start' });
  const to = h('input', { type: 'time', value: '20:00', 'aria-label': 'Shift end' });
  const addShift = on(
    h('button', { class: 'btn', type: 'button' }, 'Add shift'),
    'click',
    async () => {
      await api('POST', '/api/ops/shifts', {
        staff_id: staffSel.value,
        starts_at: new Date(`${day}T${from.value}`).toISOString(),
        ends_at: new Date(`${day}T${to.value}`).toISOString(),
      });
      toast('Shift added');
      void refresh();
    },
  );
  const parts: Node[] = [
    h('h2', {}, `Shifts · ${day}`),
    h(
      'ul',
      {},
      ...shifts.map((s) => h('li', {}, `${s.name}: ${time(s.starts_at)}–${time(s.ends_at)}`)),
    ),
    h('div', { class: 'row' }, staffSel, from, to, addShift),
  ];
  if (user.role === 'admin') {
    const f = {
      role: h(
        'select',
        { 'aria-label': 'Role' },
        h('option', { value: 'caregiver' }, 'Caregiver'),
        h('option', { value: 'courier' }, 'Courier'),
        h('option', { value: 'ops' }, 'Dispatcher'),
      ),
      name: h('input', { placeholder: 'Full name', 'aria-label': 'Name' }),
      phone: h('input', { placeholder: 'Mobile', type: 'tel', 'aria-label': 'Mobile' }),
      password: h('input', {
        placeholder: 'Temporary password (8+)',
        'aria-label': 'Temporary password',
      }),
      skills: h('input', {
        placeholder: 'Skills: nursing, physio, phlebotomy, attendant, doctor, delivery',
        'aria-label': 'Skills',
      }),
      license: h('input', { placeholder: 'Licence / registration no.', 'aria-label': 'Licence' }),
      lat: h('input', {
        placeholder: 'Home latitude',
        'aria-label': 'Home latitude',
        inputmode: 'decimal',
      }),
      lng: h('input', {
        placeholder: 'Home longitude',
        'aria-label': 'Home longitude',
        inputmode: 'decimal',
      }),
    };
    const create = on(
      h('button', { class: 'btn primary', type: 'button' }, 'Create staff account'),
      'click',
      async () => {
        await api('POST', '/api/ops/staff', {
          role: f.role.value,
          name: f.name.value,
          phone: f.phone.value.replace(/\s/g, ''),
          password: f.password.value,
          skills: f.skills.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          ...(f.license.value ? { license: f.license.value } : {}),
          home_lat: Number(f.lat.value),
          home_lng: Number(f.lng.value),
        });
        toast('Staff account created; share the temporary password with them');
        void refresh();
      },
    );
    parts.push(
      h('h2', {}, 'Add a team member'),
      h('div', { class: 'grid2' }, ...Object.values(f), create),
    );
  }
  return h('div', {}, ...parts);
}

/** Admin: clinics and the priced service catalog. */
async function setupView(refresh: () => Promise<void>): Promise<HTMLElement> {
  const [services, sites] = await Promise.all([
    api<any[]>('GET', '/api/ops/services'),
    api<any[]>('GET', '/api/sites'),
  ]);
  const svcRows = services.map((s) => {
    const price = h('input', {
      type: 'number',
      min: '0',
      step: '1',
      value: String(s.price_paise / 100),
      'aria-label': `Price of ${s.name} in rupees`,
      class: 'small',
    });
    const active = h('input', {
      type: 'checkbox',
      checked: !!s.active,
      'aria-label': `${s.name} offered`,
    });
    const save = on(
      h('button', { class: 'btn small', type: 'button' }, 'Save'),
      'click',
      async () => {
        await api('PUT', `/api/ops/services/${s.id}`, {
          price_paise: Math.round(Number(price.value) * 100),
          active: active.checked,
        });
        toast('Saved. New price applies to new bookings.');
        void refresh();
      },
    );
    return h(
      'tr',
      {},
      h('td', {}, s.name),
      h('td', {}, s.kind.replace('_', ' ')),
      h('td', {}, s.skill),
      h('td', {}, `${s.duration_min} min`),
      h('td', {}, '₹ ', price),
      h('td', {}, active),
      h('td', {}, save),
    );
  });
  const f = {
    name: h('input', { placeholder: 'Service name', 'aria-label': 'Service name' }),
    kind: h(
      'select',
      { 'aria-label': 'Kind' },
      h('option', { value: 'home_visit' }, 'Home visit'),
      h('option', { value: 'clinic_visit' }, 'Clinic visit'),
      h('option', { value: 'delivery' }, 'Delivery'),
    ),
    skill: h('input', { placeholder: 'Required skill (e.g. nursing)', 'aria-label': 'Skill' }),
    duration: h('input', {
      type: 'number',
      placeholder: 'Minutes',
      'aria-label': 'Duration in minutes',
    }),
    price: h('input', { type: 'number', placeholder: 'Price ₹', 'aria-label': 'Price in rupees' }),
    desc: h('input', { placeholder: 'What the patient gets', 'aria-label': 'Description' }),
  };
  const addSvc = on(
    h('button', { class: 'btn primary', type: 'button' }, 'Add service'),
    'click',
    async () => {
      await api('POST', '/api/ops/services', {
        name: f.name.value,
        kind: f.kind.value,
        skill: f.skill.value.trim(),
        duration_min: Number(f.duration.value),
        price_paise: Math.round(Number(f.price.value) * 100),
        description: f.desc.value,
      });
      toast('Service added');
      void refresh();
    },
  );
  const c = {
    name: h('input', { placeholder: 'Clinic name', 'aria-label': 'Clinic name' }),
    address: h('input', { placeholder: 'Full address', 'aria-label': 'Clinic address' }),
    lat: h('input', { placeholder: 'Latitude', inputmode: 'decimal', 'aria-label': 'Latitude' }),
    lng: h('input', { placeholder: 'Longitude', inputmode: 'decimal', 'aria-label': 'Longitude' }),
  };
  const addSite = on(
    h('button', { class: 'btn primary', type: 'button' }, 'Add clinic'),
    'click',
    async () => {
      await api('POST', '/api/ops/sites', {
        name: c.name.value,
        address: c.address.value,
        lat: Number(c.lat.value),
        lng: Number(c.lng.value),
        kind: 'clinic',
      });
      toast('Clinic added');
      void refresh();
    },
  );
  return h(
    'div',
    {},
    h('h2', {}, 'Services & prices'),
    h(
      'table',
      { class: 'table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['Service', 'Kind', 'Skill', 'Length', 'Price', 'Offered', ''].map((x) =>
            h('th', {}, x),
          ),
        ),
      ),
      h('tbody', {}, ...svcRows),
    ),
    h('div', { class: 'grid2' }, ...Object.values(f), addSvc),
    h('h2', {}, 'Clinics'),
    h('ul', {}, ...sites.map((s) => h('li', {}, `${s.name} · ${s.address}`))),
    h(
      'p',
      { class: 'fine' },
      'Tip: in Google Maps, right-click the clinic and click the coordinates to copy latitude and longitude.',
    ),
    h('div', { class: 'grid2' }, ...Object.values(c), addSite),
  );
}

async function auditView(): Promise<HTMLElement> {
  const rows = await api<any[]>('GET', '/api/ops/audit?limit=300');
  return h(
    'table',
    { class: 'table' },
    h('thead', {}, h('tr', {}, ...['When', 'Who', 'Action', 'Entity'].map((x) => h('th', {}, x)))),
    h(
      'tbody',
      {},
      ...rows.map((r) =>
        h(
          'tr',
          {},
          h('td', {}, when(r.at)),
          h('td', {}, r.name ?? '–'),
          h('td', {}, r.action),
          h('td', {}, `${r.entity} ${r.entity_id ?? ''}`),
        ),
      ),
    ),
  );
}

function bookForPatient(refresh: () => Promise<void>): HTMLElement {
  const q = h('input', {
    type: 'search',
    placeholder: 'Patient name or phone',
    'aria-label': 'Patient',
  });
  const pick = h('select', { 'aria-label': 'Patient match' });
  const svc = h('select', { 'aria-label': 'Service' });
  const when_ = h('input', { type: 'datetime-local', 'aria-label': 'When' });
  void api<any[]>('GET', '/api/services').then((s) =>
    svc.replaceChildren(
      ...s.filter((x) => x.kind === 'home_visit').map((x) => h('option', { value: x.id }, x.name)),
    ),
  );
  q.addEventListener('input', async () => {
    const rows = await api<any[]>('GET', `/api/ops/patients?q=${encodeURIComponent(q.value)}`);
    pick.replaceChildren(
      ...rows.map((p) => h('option', { value: p.id }, `${p.name} · ${p.phone}`)),
    );
  });
  const go = on(
    h('button', { class: 'btn', type: 'button' }, 'Book home visit'),
    'click',
    async () => {
      if (!pick.value || !when_.value) return toast('Pick a patient and a time', true);
      const r = await api<any>('POST', '/api/jobs', {
        patient_id: pick.value,
        service_id: svc.value,
        starts_at: new Date(when_.value).toISOString(),
      });
      toast(
        r.dispatch.assigned
          ? `Booked; ${r.dispatch.assigned.name} assigned`
          : 'Booked; in the queue',
      );
      void refresh();
    },
  );
  return h(
    'details',
    { class: 'card' },
    h('summary', {}, 'Book for a patient (phone bookings)'),
    h('div', { class: 'row' }, q, pick, svc, when_, go),
  );
}
