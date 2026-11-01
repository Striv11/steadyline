/** Safe DOM helper: text always via textContent, never innerHTML. */
type Child = Node | string | number | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children)
    if (c !== null && c !== undefined && c !== false)
      el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

export function on<T extends HTMLElement>(el: T, ev: string, fn: (e: Event) => unknown): T {
  el.addEventListener(
    ev,
    (e) => void Promise.resolve(fn(e)).catch((err: Error) => toast(err.message, true)),
  );
  return el;
}

export function toast(msg: string, error = false): void {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.className = error ? 'show error' : 'show';
  clearTimeout((t as unknown as { _h?: number })._h);
  (t as unknown as { _h?: number })._h = window.setTimeout(() => (t.className = ''), 4000);
}

export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
export const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
export const localDay = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};

export const STATUS_LABEL: Record<string, string> = {
  requested: 'Finding staff',
  assigned: 'Confirmed',
  en_route: 'On the way',
  arrived: 'Arrived',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};
export const badge = (status: string) =>
  h('span', { class: `badge s-${status}` }, STATUS_LABEL[status] ?? status);

/** Ask the browser for the current position; resolves null if denied or unavailable. */
export function here(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
}
