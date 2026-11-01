export interface Point {
  t: number;
  v: number;
}

/**
 * Min/max bucket downsampling: keeps each bucket's extremes so peaks and dips survive,
 * which matters for hypoglycaemia. Output has at most 2 × buckets points, in time order.
 */
export function downsampleMinMax(points: readonly Point[], buckets: number): Point[] {
  if (points.length <= buckets * 2) return points.slice();
  const out: Point[] = [];
  const size = points.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(points.length, Math.floor((b + 1) * size));
    let lo = points[from]!;
    let hi = lo;
    for (let i = from + 1; i < to; i++) {
      const p = points[i]!;
      if (p.v < lo.v) lo = p;
      if (p.v > hi.v) hi = p;
    }
    if (lo === hi) out.push(lo);
    else if (lo.t < hi.t) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}
