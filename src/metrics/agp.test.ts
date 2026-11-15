import { describe, expect, it } from 'vitest';
import { computeAgp, percentileSorted, splitByDay } from './agp';
import { generateSyntheticPatient } from '../sim/generator';

const MIN = 60_000;
const DAY = 1440 * MIN;

describe('percentileSorted', () => {
  it('matches PERCENTILE.INC on known values', () => {
    const v = [1, 2, 3, 4, 5];
    expect(percentileSorted(v, 0)).toBe(1);
    expect(percentileSorted(v, 50)).toBe(3);
    expect(percentileSorted(v, 25)).toBe(2);
    expect(percentileSorted(v, 95)).toBeCloseTo(4.8, 10);
    expect(percentileSorted(v, 100)).toBe(5);
    expect(percentileSorted([7], 30)).toBe(7);
    expect(percentileSorted([], 50)).toBeNaN();
  });
});

describe('computeAgp', () => {
  it('folds days onto one clock and computes percentiles per bin', () => {
    const samples = [];
    for (let d = 0; d < 5; d++) {
      samples.push({ t: d * DAY + 10 * MIN, mgdl: 100 + d * 10 }); // bin 0
      samples.push({ t: d * DAY + 12 * 60 * MIN, mgdl: 200 }); // 12:00 bin
    }
    const bins = computeAgp(samples, { binMinutes: 60 });
    expect(bins.map((b) => b.minute)).toEqual([0, 720]);
    expect(bins[0]).toMatchObject({ n: 5, p5: 102, p25: 110, p50: 120, p75: 130, p95: 138 });
    expect(bins[1]).toMatchObject({ p5: 200, p95: 200 });
  });
  it('applies the UTC offset and wraps negative offsets', () => {
    const s = Array.from({ length: 3 }, (_, d) => ({ t: d * DAY, mgdl: 100 }));
    expect(computeAgp(s, { utcOffsetMinutes: 330, binMinutes: 30 })[0]!.minute).toBe(330);
    expect(computeAgp(s, { utcOffsetMinutes: -60, binMinutes: 30 })[0]!.minute).toBe(1380);
  });
  it('drops sparse bins, ignores non-finite values and rejects bad widths', () => {
    const s = [
      { t: 0, mgdl: 100 },
      { t: DAY, mgdl: NaN },
      { t: 2 * DAY, mgdl: 110 },
    ];
    expect(computeAgp(s)).toEqual([]);
    expect(computeAgp(s, { minSamples: 2 })[0]!.n).toBe(2);
    expect(() => computeAgp(s, { binMinutes: 7 })).toThrow(RangeError);
  });
  it('keeps percentiles ordered on synthetic data', () => {
    const p = generateSyntheticPatient({ seed: 7, days: 14 });
    const bins = computeAgp(p.cgm);
    expect(bins.length).toBe(48);
    for (const b of bins) {
      expect(b.p5).toBeLessThanOrEqual(b.p25);
      expect(b.p25).toBeLessThanOrEqual(b.p50);
      expect(b.p50).toBeLessThanOrEqual(b.p75);
      expect(b.p75).toBeLessThanOrEqual(b.p95);
    }
  });
});

describe('splitByDay', () => {
  it('groups by local day', () => {
    const s = [
      { t: Date.parse('2026-01-01T20:00:00Z'), mgdl: 100 },
      { t: Date.parse('2026-01-01T10:00:00Z'), mgdl: 110 },
    ];
    expect(splitByDay(s).map((d) => d.day)).toEqual(['2026-01-01']);
    const ist = splitByDay(s, 330);
    expect(ist.map((d) => d.day)).toEqual(['2026-01-01', '2026-01-02']);
    expect(ist[1]!.points[0]).toEqual({ minute: 90, v: 100 });
  });
});
