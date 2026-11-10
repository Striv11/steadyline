/**
 * Glucose metrics per the international consensus on CGM metrics.
 *
 * Sources
 * - Battelino T, et al. Clinical Targets for Continuous Glucose Monitoring Data
 *   Interpretation: Recommendations From the International Consensus on Time in Range.
 *   Diabetes Care 2019;42(8):1593-1603. (ranges, CV ≤36 % target)
 * - Bergenstal RM, et al. Glucose Management Indicator (GMI). Diabetes Care 2018;41(11):2275-2280.
 *   GMI(%) = 3.31 + 0.02392 × mean glucose (mg/dL)
 * - Danne T, et al. International Consensus on Use of CGM. Diabetes Care 2017;40(12):1631-1640.
 *   (CV = SD / mean; ≥70 % wear over 14 days for reliable metrics)
 */

export interface GlucoseRanges {
  /** Level 2 hypoglycaemia threshold: < 54 mg/dL. */
  veryLow: number;
  /** Level 1 hypoglycaemia threshold: < 70 mg/dL. */
  low: number;
  /** Upper bound of time in range: ≤ 180 mg/dL. */
  high: number;
  /** Level 2 hyperglycaemia threshold: > 250 mg/dL. */
  veryHigh: number;
}

export const STANDARD_RANGES: GlucoseRanges = { veryLow: 54, low: 70, high: 180, veryHigh: 250 };

export interface GlucoseMetrics {
  n: number;
  meanMgdl: number;
  sdMgdl: number;
  /** Coefficient of variation in percent. */
  cvPercent: number;
  /** Glucose Management Indicator in percent (HbA1c-like units). */
  gmiPercent: number;
  /** Percent of readings; the five bands sum to 100. */
  tbrL2: number;
  tbrL1: number;
  tir: number;
  tarL1: number;
  tarL2: number;
  /** Combined TBR (<70) and TAR (>180) for convenience. */
  tbr: number;
  tar: number;
  /** True when CV ≤ 36 %, the consensus threshold for stable glucose. */
  stable: boolean;
}

export function gmi(meanMgdl: number): number {
  return 3.31 + 0.02392 * meanMgdl;
}

/** Convert mg/dL to mmol/L (glucose molar mass 180.16 g/mol → factor 18.016). */
export function mgdlToMmol(mgdl: number): number {
  return mgdl / 18.016;
}

/** Convert mmol/L to mg/dL. */
export function mmolToMgdl(mmol: number): number {
  return mmol * 18.016;
}

/**
 * Compute consensus metrics from glucose values in mg/dL.
 * Bands: <54 | 54–69 | 70–180 | 181–250 | >250 (readings are compared as-is, so
 * 69.5 is "low" and 180.5 is "high"; meters/CGMs report integers).
 * SD is the population SD, as used by CGM reports. Returns null for empty input.
 */
export function computeGlucoseMetrics(
  values: ArrayLike<number>,
  ranges: GlucoseRanges = STANDARD_RANGES,
): GlucoseMetrics | null {
  const n = values.length;
  if (n === 0) return null;
  let sum = 0;
  let c2l = 0;
  let c1l = 0;
  let cin = 0;
  let c1h = 0;
  let c2h = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    sum += v;
    if (v < ranges.veryLow) c2l++;
    else if (v < ranges.low) c1l++;
    else if (v <= ranges.high) cin++;
    else if (v <= ranges.veryHigh) c1h++;
    else c2h++;
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mean;
    ss += d * d;
  }
  const sd = Math.sqrt(ss / n);
  const cv = mean === 0 ? 0 : (sd / mean) * 100;
  const pct = (c: number) => (c / n) * 100;
  return {
    n,
    meanMgdl: mean,
    sdMgdl: sd,
    cvPercent: cv,
    gmiPercent: gmi(mean),
    tbrL2: pct(c2l),
    tbrL1: pct(c1l),
    tir: pct(cin),
    tarL1: pct(c1h),
    tarL2: pct(c2h),
    tbr: pct(c2l + c1l),
    tar: pct(c1h + c2h),
    stable: cv <= 36,
  };
}

/** Consensus targets for people with type 1 / type 2 diabetes (Battelino 2019, Table 2). */
export const TARGETS = {
  tirMin: 70,
  tbrMax: 4,
  tbrL2Max: 1,
  tarMax: 25,
  tarL2Max: 5,
  cvMax: 36,
} as const;
