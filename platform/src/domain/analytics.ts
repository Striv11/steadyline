/**
 * Ops analytics: pure functions over rows already filtered to a reporting window.
 * Money is integer paise; durations are minutes.
 */
export interface JobRow {
  id: string;
  service_id: string;
  service_name: string;
  staff_id: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  price_paise: number;
  payment_status: string;
}
export interface ShiftRow {
  staff_id: string;
  starts_at: string;
  ends_at: string;
}
export interface AlertRow {
  severity: string;
  created_at: string;
  acknowledged_at: string | null;
}

const mins = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Nearest-rank percentile of a numeric list; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1]!;
}

export interface StaffUtilization {
  staff_id: string;
  shift_minutes: number;
  booked_minutes: number;
  jobs: number;
  /** booked / shift, or null when the person had no shifts in the window. */
  utilization: number | null;
}

/** Booked time counts visits that were staffed and not cancelled; no-shows still occupied the slot. */
export function staffUtilization(jobs: JobRow[], shifts: ShiftRow[]): StaffUtilization[] {
  const by = new Map<string, StaffUtilization>();
  const get = (id: string) => {
    let r = by.get(id);
    if (!r)
      by.set(
        id,
        (r = { staff_id: id, shift_minutes: 0, booked_minutes: 0, jobs: 0, utilization: null }),
      );
    return r;
  };
  for (const s of shifts) get(s.staff_id).shift_minutes += mins(s.starts_at, s.ends_at);
  for (const j of jobs) {
    if (!j.staff_id || j.status === 'cancelled' || j.status === 'requested') continue;
    const r = get(j.staff_id);
    r.booked_minutes += mins(j.starts_at, j.ends_at);
    r.jobs += 1;
  }
  const out = [...by.values()];
  for (const r of out) {
    r.shift_minutes = round1(r.shift_minutes);
    r.booked_minutes = round1(r.booked_minutes);
    r.utilization =
      r.shift_minutes > 0 ? Math.round((r.booked_minutes / r.shift_minutes) * 1000) / 1000 : null;
  }
  return out.sort((a, b) => a.staff_id.localeCompare(b.staff_id));
}

export interface ServiceRevenue {
  service_id: string;
  service_name: string;
  completed: number;
  /** Price of completed visits that are not waived. */
  billed_paise: number;
  /** Portion of billed_paise already paid. */
  collected_paise: number;
}

export function revenueByService(jobs: JobRow[]): ServiceRevenue[] {
  const by = new Map<string, ServiceRevenue>();
  for (const j of jobs) {
    if (j.status !== 'completed') continue;
    let r = by.get(j.service_id);
    if (!r)
      by.set(
        j.service_id,
        (r = {
          service_id: j.service_id,
          service_name: j.service_name,
          completed: 0,
          billed_paise: 0,
          collected_paise: 0,
        }),
      );
    r.completed += 1;
    if (j.payment_status !== 'waived') r.billed_paise += j.price_paise;
    if (j.payment_status === 'paid') r.collected_paise += j.price_paise;
  }
  return [...by.values()].sort(
    (a, b) => b.billed_paise - a.billed_paise || a.service_id.localeCompare(b.service_id),
  );
}

export interface Outcomes {
  total: number;
  completed: number;
  cancelled: number;
  no_show: number;
  /** Over visits that reached a final state (completed, cancelled, no_show); null if none. */
  cancellation_rate: number | null;
  no_show_rate: number | null;
}

export function outcomes(jobs: JobRow[]): Outcomes {
  let completed = 0,
    cancelled = 0,
    noShow = 0;
  for (const j of jobs) {
    if (j.status === 'completed') completed++;
    else if (j.status === 'cancelled') cancelled++;
    else if (j.status === 'no_show') noShow++;
  }
  const final = completed + cancelled + noShow;
  const rate = (n: number) => (final ? Math.round((n / final) * 1000) / 1000 : null);
  return {
    total: jobs.length,
    completed,
    cancelled,
    no_show: noShow,
    cancellation_rate: rate(cancelled),
    no_show_rate: rate(noShow),
  };
}

export interface AlertResponse {
  critical: number;
  acknowledged: number;
  unacknowledged: number;
  median_minutes: number | null;
  p90_minutes: number | null;
}

export function alertResponse(alerts: AlertRow[]): AlertResponse {
  const crit = alerts.filter((a) => a.severity === 'critical');
  const times = crit
    .filter((a) => a.acknowledged_at)
    .map((a) => mins(a.created_at, a.acknowledged_at!));
  const r = (n: number | null) => (n === null ? null : round1(n));
  return {
    critical: crit.length,
    acknowledged: times.length,
    unacknowledged: crit.length - times.length,
    median_minutes: r(percentile(times, 50)),
    p90_minutes: r(percentile(times, 90)),
  };
}

/** RFC 4180 CSV; cells starting with = + - @ are prefixed to defuse spreadsheet formula injection. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v === null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
