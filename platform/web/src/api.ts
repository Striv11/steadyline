export type Role = 'patient' | 'caregiver' | 'courier' | 'ops' | 'admin';
export interface User {
  id: string;
  role: Role;
  name: string;
  phone: string;
}
export type Job = Record<string, any> & {
  id: string;
  status: string;
  kind: 'home_visit' | 'clinic_visit' | 'delivery';
  starts_at: string;
  ends_at: string;
};

const KEY = 'steadyline-care-session';

export const session = {
  get(): { token: string; user: User } | null {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  set(s: { token: string; user: User }) {
    localStorage.setItem(KEY, JSON.stringify(s));
  },
  clear() {
    localStorage.removeItem(KEY);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const s = session.get();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(s ? { authorization: `Bearer ${s.token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && s) {
    session.clear();
    location.hash = '#/';
    location.reload();
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      (data as any).error + ((data as any).issues ? `: ${(data as any).issues.join('; ')}` : ''),
    );
  return data as T;
}

/** Live updates: calls `onChange` whenever a job or alert this user can see changes. */
export function live(onChange: () => void): () => void {
  const s = session.get();
  if (!s || typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(`/api/events?token=${encodeURIComponent(s.token)}`);
  let t: number | undefined;
  const bump = () => {
    clearTimeout(t);
    t = window.setTimeout(onChange, 250);
  };
  es.addEventListener('job', bump);
  es.addEventListener('alert', bump);
  return () => es.close();
}

/** Fetch an authenticated PDF and open it in a new tab. */
export async function openPdf(path: string): Promise<void> {
  const s = session.get();
  const res = await fetch(path, { headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'could not load the document');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
