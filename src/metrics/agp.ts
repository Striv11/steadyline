import type { GlucoseSample } from '../sim/generator';

/**
 * Ambulatory Glucose Profile (AGP): all days are folded onto one 24 h clock and the
 * 5th/25th/50th/75th/95th percentiles are computed per time-of-day bin
 * (Battelino et al., Diabetes Care 2019; Bergenstal et al., Diabetes Technol Ther 2013).
 */
export interface AgpBin {
  /** Minutes after local midnight at the start of the bin. */
  minute: number;
  n: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface AgpOptions {
  /** Bin width in minutes; must divide 1440. Default 30. */
  binMinutes?: number;
  /** Local-time offset from UTC in minutes (e.g. 330 for IST). Default 0. */
  utcOffsetMinutes?: number;
  /** Bins with fewer samples than this are omitted. Default 3. */
  minSamples?: number;
}

const DAY_MIN = 1440;

/** Percentile of an ascending-sorted array with linear interpolation (R-7 / Excel PERCENTILE.INC). */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function computeAgp(samples: readonly GlucoseSample[], opts: AgpOptions = {}): AgpBin[] {
  const width = opts.binMinutes ?? 30;
  if (!Number.isInteger(width) || width <= 0 || DAY_MIN % width !== 0) {
    throw new RangeError('binMinutes must be a positive divisor of 1440');
  }
  const offsetMs = (opts.utcOffsetMinutes ?? 0) * 60_000;
  const minN = opts.minSamples ?? 3;
  const nBins = DAY_MIN / width;
  const buckets: number[][] = Array.from({ length: nBins }, () => []);
  for (const s of samples) {
    if (!Number.isFinite(s.t) || !Number.isFinite(s.mgdl)) continue;
    const minuteOfDay = ((Math.floor((s.t + offsetMs) / 60_000) % DAY_MIN) + DAY_MIN) % DAY_MIN;
    buckets[Math.floor(minuteOfDay / width)]!.push(s.mgdl);
  }
  const out: AgpBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const vals = buckets[b]!;
    if (vals.length === 0 || vals.length < minN) continue;
    const sorted = Float64Array.from(vals).sort();
    out.push({
      minute: b * width,
      n: sorted.length,
      p5: percentileSorted(sorted, 5),
      p25: percentileSorted(sorted, 25),
      p50: percentileSorted(sorted, 50),
      p75: percentileSorted(sorted, 75),
      p95: percentileSorted(sorted, 95),
    });
  }
  return out;
}

/** Samples grouped by local calendar day, for daily overlays. Days are in ascending order. */
export function splitByDay(
  samples: readonly GlucoseSample[],
  utcOffsetMinutes = 0,
): { day: string; points: { minute: number; v: number }[] }[] {
  const offsetMs = utcOffsetMinutes * 60_000;
  const map = new Map<string, { minute: number; v: number }[]>();
  for (const s of samples) {
    const local = s.t + offsetMs;
    const day = new Date(local).toISOString().slice(0, 10);
    const minute = ((Math.floor(local / 60_000) % DAY_MIN) + DAY_MIN) % DAY_MIN;
    (map.get(day) ?? map.set(day, []).get(day)!).push({ minute, v: s.mgdl });
  }
  return [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, points]) => ({ day, points }));
}
