import { describe, expect, it } from 'vitest';
import { computeAgp } from '../metrics/agp';
import { downsampleMinMax } from '../metrics/downsample';
import { generateSyntheticPatient } from '../sim/generator';
import { agpGeometry } from './charts';

describe('performance budget (Day 7)', () => {
  it('one year of minute-level CGM (525,600 points) is profiled and laid out in under 1 s', () => {
    const p = generateSyntheticPatient({ seed: 3, days: 365, cgmIntervalMin: 1 });
    expect(p.cgm.length).toBeGreaterThanOrEqual(525_600);
    const pts = p.cgm.map((c) => ({ t: c.t, v: c.mgdl }));
    const t0 = performance.now();
    const bins = computeAgp(p.cgm, { utcOffsetMinutes: 330 });
    const geo = agpGeometry(bins, 30);
    const line = downsampleMinMax(pts, 300);
    const ms = performance.now() - t0;
    expect(bins).toHaveLength(48);
    expect(geo.median.startsWith('M')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(600);
    // Generous CI headroom over the 1 s budget measured on a laptop (~100 ms).
    expect(ms).toBeLessThan(1000);
  }, 60_000);
  it('geometry is empty for no data', () => {
    expect(agpGeometry([], 30).median).toBe('');
  });
});
