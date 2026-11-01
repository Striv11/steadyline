import { describe, expect, it } from 'vitest';
import { downsampleMinMax, type Point } from './downsample';

describe('downsampleMinMax', () => {
  const pts: Point[] = Array.from({ length: 10000 }, (_, i) => ({ t: i, v: 100 + (i % 50) }));
  it('keeps extremes and bounds output size', () => {
    pts[5000] = { t: 5000, v: 38 };
    const out = downsampleMinMax(pts, 100);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(Math.min(...out.map((p) => p.v))).toBe(38);
    expect(out.map((p) => p.t)).toEqual([...out.map((p) => p.t)].sort((a, b) => a - b));
  });
  it('returns small inputs unchanged', () => {
    expect(downsampleMinMax(pts.slice(0, 10), 100)).toHaveLength(10);
  });
});
