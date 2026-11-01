import { api } from './api';
import { badge, h, time } from './dom';

interface Live {
  staff: {
    id: string;
    name: string;
    role: string;
    phone: string;
    lat: number;
    lng: number;
    at: string;
  }[];
  jobs: {
    id: string;
    status: string;
    kind: string;
    lat: number;
    lng: number;
    starts_at: string;
    address: string;
    staff_id: string | null;
    patient: string;
    eta_min?: number;
  }[];
}

/** Live operations map: staff positions and today's open jobs. Leaflet loads only when this tab opens. */
export async function liveMap(): Promise<HTMLElement> {
  const [L, data] = await Promise.all([import('leaflet'), api<Live>('GET', '/api/ops/live')]);
  await import('leaflet/dist/leaflet.css');
  const box = h('div', {
    class: 'map',
    'data-testid': 'live-map',
    role: 'region',
    'aria-label': 'Live map',
  });
  const legend = h(
    'p',
    { class: 'fine' },
    `${data.staff.length} staff reporting location · ${data.jobs.length} open jobs · `,
    h('span', { class: 'dot-staff' }, '●'),
    ' staff  ',
    h('span', { class: 'dot-job' }, '●'),
    ' job  ',
    h('span', { class: 'dot-enroute' }, '●'),
    ' on the way',
  );
  const list = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h('tr', {}, ...['Time', 'Patient', 'Where', 'Status', 'ETA'].map((x) => h('th', {}, x))),
    ),
    h(
      'tbody',
      {},
      ...data.jobs.map((j) =>
        h(
          'tr',
          {},
          h('td', {}, time(j.starts_at)),
          h('td', {}, j.patient),
          h('td', {}, j.address),
          h('td', {}, badge(j.status)),
          h('td', {}, j.eta_min != null ? `${j.eta_min} min` : '–'),
        ),
      ),
    ),
  );
  const wrap = h('div', {}, legend, box, list);
  // Leaflet needs the container in the document to size itself.
  requestAnimationFrame(() => {
    const points: [number, number][] = [
      ...data.staff.map((s) => [s.lat, s.lng] as [number, number]),
      ...data.jobs.map((j) => [j.lat, j.lng] as [number, number]),
    ];
    const map = L.map(box, { scrollWheelZoom: false }).setView(points[0] ?? [18.52, 73.85], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    for (const j of data.jobs)
      L.circleMarker([j.lat, j.lng], {
        radius: 8,
        color: j.status === 'en_route' ? '#2563eb' : '#b54708',
        fillOpacity: 0.7,
      })
        .addTo(map)
        .bindTooltip(
          `${time(j.starts_at)} ${j.patient} (${j.status.replace('_', ' ')})${j.eta_min != null ? `, ETA ${j.eta_min} min` : ''}`,
        );
    for (const s of data.staff)
      L.circleMarker([s.lat, s.lng], { radius: 7, color: '#0f766e', fillOpacity: 0.9 })
        .addTo(map)
        .bindTooltip(`${s.name}, seen ${time(s.at)}`);
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [30, 30] });
  });
  return wrap;
}

/** Outbox: every SMS/WhatsApp the platform sent or tried to send. */
export async function messagesView(): Promise<HTMLElement> {
  const rows = await api<any[]>('GET', '/api/ops/notifications?limit=300');
  if (!rows.length) return h('p', { class: 'empty' }, 'No messages yet.');
  const provider = rows[0].provider;
  return h(
    'div',
    {},
    provider === 'log'
      ? h(
          'p',
          { class: 'notice', 'data-testid': 'log-mode' },
          'Messages are being recorded but not sent: no SMS/WhatsApp provider is configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM on the server to send them.',
        )
      : null,
    h(
      'table',
      { class: 'table', 'data-testid': 'messages' },
      h(
        'thead',
        {},
        h('tr', {}, ...['When', 'To', 'Type', 'Message', 'Status'].map((x) => h('th', {}, x))),
      ),
      h(
        'tbody',
        {},
        ...rows.map((n) =>
          h(
            'tr',
            {},
            h('td', {}, time(n.created_at)),
            h('td', {}, `${n.user_name ?? ''} ${n.to_phone}`),
            h('td', {}, n.template.replace(/_/g, ' ')),
            h('td', {}, n.body),
            h(
              'td',
              { class: n.status === 'failed' ? 'error' : '' },
              n.status === 'failed' ? `failed: ${n.error}` : n.status,
            ),
          ),
        ),
      ),
    ),
  );
}
