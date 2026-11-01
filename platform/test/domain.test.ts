import { describe, expect, it } from 'vitest';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/auth.js';
import { haversineKm, rank, travelMinutes, type Candidate } from '../src/domain/dispatch.js';
import { transition, TransitionError } from '../src/domain/jobs.js';
import { assess, validateReading } from '../src/domain/vitals.js';

const H = 3600_000;
const T0 = Date.parse('2026-11-02T04:30:00Z'); // 10:00 IST
const pune = { lat: 18.52, lng: 73.85 };

const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  name: over.id,
  skills: ['nursing'],
  base: pune,
  shifts: [{ start: T0 - 2 * H, end: T0 + 10 * H }],
  jobs: [],
  maxJobsPerDay: 8,
  ...over,
});

describe('dispatch', () => {
  it('measures distance and travel', () => {
    expect(haversineKm({ lat: 18.52, lng: 73.85 }, { lat: 19.076, lng: 72.877 })).toBeGreaterThan(
      115,
    );
    expect(travelMinutes(pune, pune)).toBe(10);
  });
  const job = { skill: 'nursing', start: T0, end: T0 + H, at: { lat: 18.53, lng: 73.86 } };
  it('picks the nearest qualified, available person', () => {
    const r = rank(job, [
      cand({ id: 'far', base: { lat: 18.65, lng: 73.95 } }),
      cand({ id: 'near', base: { lat: 18.531, lng: 73.861 } }),
      cand({ id: 'physio', skills: ['physio'], base: job.at }),
    ]);
    expect(r.eligible.map((e) => e.id)).toEqual(['near', 'far']);
    expect(r.rejected).toEqual([
      expect.objectContaining({ id: 'physio', reason: 'lacks skill nursing' }),
    ]);
  });
  it('respects shifts, overlaps, travel between jobs and daily caps', () => {
    const r = rank(job, [
      cand({ id: 'offshift', shifts: [{ start: T0 + 2 * H, end: T0 + 8 * H }] }),
      cand({ id: 'busy', jobs: [{ start: T0 + 0.5 * H, end: T0 + 1.5 * H, at: pune }] }),
      cand({
        id: 'tight',
        jobs: [{ start: T0 - H, end: T0 - 5 * 60_000, at: { lat: 18.65, lng: 73.95 } }],
      }),
      cand({
        id: 'capped',
        maxJobsPerDay: 1,
        jobs: [{ start: T0 + 5 * H, end: T0 + 6 * H, at: pune }],
      }),
      cand({
        id: 'late-next',
        jobs: [{ start: T0 + H + 5 * 60_000, end: T0 + 2 * H, at: { lat: 18.65, lng: 73.95 } }],
      }),
      cand({ id: 'ok' }),
    ]);
    expect(r.eligible.map((e) => e.id)).toEqual(['ok']);
    const why = Object.fromEntries(r.rejected.map((x) => [x.id, x.reason]));
    expect(why['offshift']).toMatch(/shift/);
    expect(why['busy']).toMatch(/overlaps/);
    expect(why['tight']).toMatch(/in time/);
    expect(why['capped']).toMatch(/cap/);
    expect(why['late-next']).toMatch(/late/);
  });
  it('spreads load between equally close people', () => {
    const r = rank(job, [
      cand({
        id: 'loaded',
        jobs: [
          { start: T0 + 4 * H, end: T0 + 5 * H, at: pune },
          { start: T0 + 6 * H, end: T0 + 7 * H, at: pune },
        ],
      }),
      cand({ id: 'free' }),
    ]);
    expect(r.eligible[0]!.id).toBe('free');
  });
});

describe('job lifecycle', () => {
  const home = {
    status: 'assigned' as const,
    kind: 'home_visit' as const,
    patient_id: 'p',
    staff_id: 's',
  };
  const nurse = { id: 's', role: 'caregiver' as const };
  it('walks the happy path', () => {
    expect(transition(home, 'start', nurse)).toBe('en_route');
    expect(transition({ ...home, status: 'en_route' }, 'arrive', nurse)).toBe('arrived');
    expect(transition({ ...home, status: 'arrived' }, 'begin', nurse)).toBe('in_progress');
    expect(transition({ ...home, status: 'in_progress' }, 'complete', nurse)).toBe('completed');
  });
  it('enforces who may act', () => {
    expect(() => transition(home, 'start', { id: 'other', role: 'caregiver' })).toThrow(
      /not assigned to you/,
    );
    expect(() => transition(home, 'assign', nurse)).toThrow(TransitionError);
    expect(() => transition(home, 'cancel', { id: 'q', role: 'patient' })).toThrow(
      /not your booking/,
    );
    expect(() =>
      transition({ ...home, status: 'en_route' }, 'cancel', { id: 'p', role: 'patient' }),
    ).toThrow(/on the way/);
    expect(transition({ ...home, status: 'en_route' }, 'cancel', { id: 'o', role: 'ops' })).toBe(
      'cancelled',
    );
  });
  it('enforces order and kind rules', () => {
    expect(() => transition(home, 'arrive', nurse)).toThrow(/start the trip/);
    expect(() => transition({ ...home, status: 'arrived' }, 'complete', nurse)).toThrow(
      /begin the visit/,
    );
    expect(() =>
      transition({ ...home, status: 'completed' }, 'cancel', { id: 'o', role: 'ops' }),
    ).toThrow(/completed/);
    const clinic = { ...home, kind: 'clinic_visit' as const };
    expect(transition(clinic, 'arrive', nurse)).toBe('arrived');
    expect(() => transition(clinic, 'start', nurse)).toThrow(/clinic_visit/);
    const delivery = { ...home, kind: 'delivery' as const, status: 'arrived' as const };
    expect(transition(delivery, 'complete', { id: 's', role: 'courier' })).toBe('completed');
    expect(() => transition(delivery, 'begin', { id: 's', role: 'courier' })).toThrow(/delivery/);
  });
});

describe('vitals', () => {
  it('rejects implausible readings', () => {
    expect(validateReading({ code: 'spo2', value: 140 })).toMatch(/outside/);
    expect(validateReading({ code: 'bp', value: 120 })).toMatch(/Diastolic/);
    expect(validateReading({ code: 'bp', value: 80, value2: 90 })).toMatch(/lower than systolic/);
    expect(validateReading({ code: 'bp', value: 128, value2: 82 })).toBeNull();
  });
  it('flags dangerous values with the right severity', () => {
    expect(assess({ code: 'bp', value: 185, value2: 110 })?.severity).toBe('critical');
    expect(assess({ code: 'bp', value: 165, value2: 95 })?.severity).toBe('warning');
    expect(assess({ code: 'bp', value: 124, value2: 80 })).toBeNull();
    expect(assess({ code: 'glucose', value: 50 })?.severity).toBe('critical');
    expect(assess({ code: 'glucose', value: 65 })?.severity).toBe('warning');
    expect(assess({ code: 'spo2', value: 88 })?.severity).toBe('critical');
    expect(assess({ code: 'temp', value: 38.2 })?.severity).toBe('warning');
    expect(assess({ code: 'hr', value: 72 })).toBeNull();
  });
});

describe('auth', () => {
  it('hashes passwords and signs tokens', () => {
    const h = hashPassword('correct horse');
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    const t = signToken({ sub: 'u1', role: 'ops' }, 'secret');
    expect(verifyToken(t, 'secret')?.sub).toBe('u1');
    expect(verifyToken(t, 'other')).toBeNull();
    expect(verifyToken(t.slice(0, -2) + 'xx', 'secret')).toBeNull();
    expect(verifyToken(signToken({ sub: 'u', role: 'ops' }, 's', -1), 's')).toBeNull();
  });
});
