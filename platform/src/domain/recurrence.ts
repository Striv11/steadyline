/**
 * Recurrence rules for care plans: a small, strict subset of RFC 5545 RRULE.
 *
 *   FREQ=DAILY|WEEKLY            (required)
 *   INTERVAL=n                   every n days / weeks (1..12, default 1)
 *   BYDAY=MO,TU,...              weekly only; defaults to the weekday of the start date
 *   COUNT=n  or  UNTIL=YYYYMMDD  optional end (not both), COUNT counts from the start date
 *
 * Dates are calendar days in the patient's local time ("YYYY-MM-DD"); the plan
 * carries a time of day and a fixed UTC offset, so a 09:00 visit stays at 09:00
 * local. Weeks start on Monday, as in the RRULE default (WKST=MO).
 */
export type Freq = 'DAILY' | 'WEEKLY';
export interface Rule {
  freq: Freq;
  interval: number;
  /** 0 = Monday ... 6 = Sunday; only used for WEEKLY. */
  byday: number[];
  count?: number;
  until?: string; // YYYY-MM-DD
}

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RuleError extends Error {}

const dayNumber = (date: string) => {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!DATE.test(date) || Number.isNaN(t)) throw new RuleError(`invalid date "${date}"`);
  return Math.floor(t / DAY_MS);
};
const dateOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** 0 = Monday. 1970-01-01 (day 0) was a Thursday. */
const weekdayOf = (n: number) => (((n + 3) % 7) + 7) % 7;

export function parseRule(text: string, startDate: string): Rule {
  const parts = new Map<string, string>();
  for (const seg of text
    .trim()
    .replace(/^RRULE:/, '')
    .split(';')) {
    const [k, v, ...rest] = seg.split('=');
    if (!k || !v || rest.length) throw new RuleError(`malformed rule segment "${seg}"`);
    const key = k.toUpperCase();
    if (parts.has(key)) throw new RuleError(`duplicate ${key}`);
    parts.set(key, v.toUpperCase());
  }
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL']);
  for (const k of parts.keys()) if (!known.has(k)) throw new RuleError(`unsupported ${k}`);
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY') throw new RuleError('FREQ must be DAILY or WEEKLY');
  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 12)
    throw new RuleError('INTERVAL must be a whole number from 1 to 12');
  let byday: number[] = [];
  if (parts.has('BYDAY')) {
    if (freq !== 'WEEKLY') throw new RuleError('BYDAY is only valid with FREQ=WEEKLY');
    byday = parts
      .get('BYDAY')!
      .split(',')
      .map((d) => {
        const i = DAYS.indexOf(d);
        if (i < 0) throw new RuleError(`unknown weekday "${d}"`);
        return i;
      });
    byday = [...new Set(byday)].sort((a, b) => a - b);
  } else if (freq === 'WEEKLY') byday = [weekdayOf(dayNumber(startDate))];
  if (parts.has('COUNT') && parts.has('UNTIL')) throw new RuleError('use COUNT or UNTIL, not both');
  const rule: Rule = { freq, interval, byday };
  if (parts.has('COUNT')) {
    const n = Number(parts.get('COUNT'));
    if (!Number.isInteger(n) || n < 1 || n > 366) throw new RuleError('COUNT must be 1 to 366');
    rule.count = n;
  }
  if (parts.has('UNTIL')) {
    const u = parts.get('UNTIL')!;
    if (!/^\d{8}$/.test(u)) throw new RuleError('UNTIL must be YYYYMMDD');
    rule.until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6)}`;
    dayNumber(rule.until);
  }
  return rule;
}

/**
 * Occurrence dates (local calendar days) within [from, to], inclusive, in order.
 * Enumerates from the start date so COUNT is honoured regardless of the window.
 */
export function occurrences(rule: Rule, startDate: string, from: string, to: string): string[] {
  const start = dayNumber(startDate);
  const lo = Math.max(dayNumber(from), start);
  let hi = dayNumber(to);
  if (rule.until) hi = Math.min(hi, dayNumber(rule.until));
  const out: string[] = [];
  let emitted = 0;
  const startWeek = Math.floor((start - weekdayOf(start)) / 7); // Monday-based week index
  for (let d = start; d <= hi; d++) {
    let hit: boolean;
    if (rule.freq === 'DAILY') hit = (d - start) % rule.interval === 0;
    else {
      const week = Math.floor((d - weekdayOf(d)) / 7);
      hit = (week - startWeek) % rule.interval === 0 && rule.byday.includes(weekdayOf(d));
    }
    if (!hit) continue;
    emitted++;
    if (rule.count !== undefined && emitted > rule.count) break;
    if (d >= lo) out.push(dateOf(d));
  }
  return out;
}

/** UTC instant of a local date and "HH:MM" at a fixed offset (minutes east of UTC). */
export function localToUtc(date: string, time: string, tzOffsetMin: number): Date {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RuleError(`invalid time "${time}"`);
  return new Date(Date.parse(`${date}T${time}:00Z`) - tzOffsetMin * 60_000);
}

/** Local calendar day of a UTC instant at a fixed offset. */
export function localDate(at: Date, tzOffsetMin: number): string {
  return new Date(at.getTime() + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}
