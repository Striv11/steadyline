import { describe, expect, it } from 'vitest';
import { generateSyntheticPatient } from './generator';
import { Rng } from './rng';
import { validateBundle, toBundle } from '../domain/validate';
import { computeGlucoseMetrics } from '../metrics/glucose';

describe('Rng', () => {
  it('is deterministic and uniform-ish', () => {
    const a = new Rng(1);
    const b = new Rng(1);
    const xs = Array.from({ length: 1000 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b.next()));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
  it('matches a pinned first value (guards cross-platform drift)', () => {
    expect(new Rng(123).next()).toBeCloseTo(0.7872516233, 6);
  });
});

describe('generateSyntheticPatient', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = generateSyntheticPatient({ seed: 7, days: 10 });
    const b = generateSyntheticPatient({ seed: 7, days: 10 });
    const c = generateSyntheticPatient({ seed: 8, days: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('produces the right CGM sample count and plausible metrics', () => {
    const p = generateSyntheticPatient({ days: 14, cgmIntervalMin: 5 });
    expect(p.cgm).toHaveLength(14 * 288);
    const m = computeGlucoseMetrics(p.cgm.map((s) => s.mgdl))!;
    expect(m.tir).toBeGreaterThan(40);
    expect(m.tir).toBeLessThan(100);
    expect(m.meanMgdl).toBeGreaterThan(100);
    expect(m.meanMgdl).toBeLessThan(190);
    for (const s of p.cgm) expect(s.mgdl).toBeGreaterThanOrEqual(40);
  });

  it('is clearly labelled synthetic and every resource validates', () => {
    const p = generateSyntheticPatient({ days: 30 });
    expect(p.synthetic).toBe(true);
    const patient = p.resources.find((r) => r.resourceType === 'Patient')!;
    expect(JSON.stringify(patient)).toContain('synthetic');
    const bundle = toBundle(p.resources, '2026-01-01T00:00:00Z');
    expect(validateBundle(bundle)).toEqual([]);
  });
});
