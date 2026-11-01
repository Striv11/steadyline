import { describe, expect, it } from 'vitest';
import { computeGlucoseMetrics, gmi, mgdlToMmol } from './glucose';

describe('GMI (Bergenstal 2018: 3.31 + 0.02392 × mean mg/dL)', () => {
  it('matches the published worked values', () => {
    // Mean 154 mg/dL (ADAG eAG for A1c 7 %) → GMI ≈ 7.0 %
    expect(gmi(154)).toBeCloseTo(6.99, 2);
    // Mean 100 → 5.70; mean 200 → 8.09; mean 150 → 6.90
    expect(gmi(100)).toBeCloseTo(5.7, 2);
    expect(gmi(150)).toBeCloseTo(6.9, 2);
    expect(gmi(200)).toBeCloseTo(8.09, 2);
  });
});

describe('computeGlucoseMetrics', () => {
  it('returns null for no data', () => {
    expect(computeGlucoseMetrics([])).toBeNull();
  });

  it('classifies band boundaries per Battelino 2019', () => {
    // 53 (L2 low), 54 & 69 (L1 low), 70 & 180 (in range), 181 & 250 (L1 high), 251 (L2 high)
    const m = computeGlucoseMetrics([53, 54, 69, 70, 180, 181, 250, 251])!;
    expect(m.tbrL2).toBeCloseTo(12.5);
    expect(m.tbrL1).toBeCloseTo(25);
    expect(m.tir).toBeCloseTo(25);
    expect(m.tarL1).toBeCloseTo(25);
    expect(m.tarL2).toBeCloseTo(12.5);
    expect(m.tbr).toBeCloseTo(37.5);
    expect(m.tar).toBeCloseTo(37.5);
    expect(m.tbrL2 + m.tbrL1 + m.tir + m.tarL1 + m.tarL2).toBeCloseTo(100);
  });

  it('computes mean, population SD and CV', () => {
    // Values 100,120,140,160,180: mean 140, population SD = sqrt(800) ≈ 28.284
    const m = computeGlucoseMetrics([100, 120, 140, 160, 180])!;
    expect(m.meanMgdl).toBe(140);
    expect(m.sdMgdl).toBeCloseTo(28.284, 3);
    expect(m.cvPercent).toBeCloseTo(20.203, 2);
    expect(m.gmiPercent).toBeCloseTo(3.31 + 0.02392 * 140, 6);
    expect(m.stable).toBe(true);
    expect(m.tir).toBe(100);
  });

  it('flags unstable glucose when CV exceeds 36 %', () => {
    const m = computeGlucoseMetrics([50, 300, 60, 280, 55, 290])!;
    expect(m.cvPercent).toBeGreaterThan(36);
    expect(m.stable).toBe(false);
  });

  it('works on typed arrays', () => {
    const m = computeGlucoseMetrics(Float64Array.from([100, 100, 100]))!;
    expect(m.cvPercent).toBe(0);
    expect(m.tir).toBe(100);
  });
});

describe('unit conversion', () => {
  it('converts 180 mg/dL to ~10 mmol/L', () => {
    expect(mgdlToMmol(180)).toBeCloseTo(9.99, 2);
    expect(mgdlToMmol(70)).toBeCloseTo(3.89, 2);
  });
});
