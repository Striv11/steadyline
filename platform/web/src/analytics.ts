import { api, session } from './api';
import { h, on, rupees, toast } from './dom';

const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
const mins = (n: number | null) => (n === null ? 'n/a' : `${n} min`);

function table(head: string[], rows: (string | number)[][], label: string): HTMLElement {
  return h(
    'table',
    { class: 'table', 'aria-label': label },
    h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, String(c)))))),
  );
}

async function download(query: string, report: string): Promise<void> {
  const res = await fetch(`/api/ops/analytics?${query}&report=${report}&format=csv`, {
    headers: { authorization: `Bearer ${session.get()?.token ?? ''}` },
  });
  if (!res.ok) return toast('Export failed', true);
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: `${report}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

/** Ops analytics tab: utilization, revenue, outcomes and alert response with CSV export. */
export async function analyticsView(): Promise<HTMLElement> {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fromIn = h('input', { type: 'date', value: iso(from), 'aria-label': 'From' });
  const toIn = h('input', { type: 'date', value: iso(to), 'aria-label': 'To' });
  const out = h('div', {});
  const load = async () => {
    const q = `from=${fromIn.value}&to=${toIn.value}`;
    const d = await api<any>('GET', `/api/ops/analytics?${q}`);
    const csvBtn = (report: string) =>
      on(h('button', { type: 'button', class: 'btn' }, 'Export CSV'), 'click', () =>
        download(q, report),
      );
    out.replaceChildren(
      h('h3', {}, 'Visits'),
      h(
        'p',
        { 'data-testid': 'outcomes' },
        `${d.outcomes.completed} completed, ${d.outcomes.cancelled} cancelled (${pct(d.outcomes.cancellation_rate)}), ${d.outcomes.no_show} no-shows (${pct(d.outcomes.no_show_rate)}).`,
      ),
      h('h3', {}, 'Critical alert response'),
      h(
        'p',
        {},
        `${d.alerts.critical} critical, ${d.alerts.unacknowledged} unacknowledged. Median ${mins(d.alerts.median_minutes)}, 90th percentile ${mins(d.alerts.p90_minutes)}.`,
        ' ',
        csvBtn('alerts'),
      ),
      h('h3', {}, 'Staff utilization'),
      csvBtn('staff'),
      table(
        ['Staff', 'Visits', 'Booked (min)', 'Shifts (min)', 'Utilization'],
        d.staff.map((s: any) => [
          s.name,
          s.jobs,
          s.booked_minutes,
          s.shift_minutes,
          pct(s.utilization),
        ]),
        'Staff utilization',
      ),
      h('h3', {}, 'Revenue by service'),
      csvBtn('services'),
      table(
        ['Service', 'Completed', 'Billed', 'Collected'],
        d.services.map((s: any) => [
          s.service_name,
          s.completed,
          rupees(s.billed_paise),
          rupees(s.collected_paise),
        ]),
        'Revenue by service',
      ),
    );
  };
  on(fromIn, 'change', load);
  on(toIn, 'change', load);
  await load();
  return h('div', {}, h('div', { class: 'row' }, 'From ', fromIn, ' to ', toIn), out);
}
