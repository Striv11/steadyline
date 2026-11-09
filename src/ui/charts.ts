import { h, s } from './dom';
import { downsampleMinMax, type Point } from '../metrics/downsample';
import type { GlucoseMetrics } from '../metrics/glucose';
import { BP_LABELS, type BpDay } from '../metrics/bp';

const W = 720;
const H = 260;
const PAD = { l: 44, r: 12, t: 12, b: 28 };

/** Glucose line chart with 70–180 target band, plus a screen-reader data table. */
export function glucoseChart(points: Point[], title: string): HTMLElement {
  const ds = downsampleMinMax(points, 300);
  const t0 = ds[0]?.t ?? 0;
  const t1 = ds[ds.length - 1]?.t ?? 1;
  const yMax = 300;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - Math.min(v, yMax) / yMax) * (H - PAD.t - PAD.b);
  const d = ds.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const svg = s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title, class: 'chart' },
    s('rect', {
      x: PAD.l,
      y: y(180),
      width: W - PAD.l - PAD.r,
      height: y(70) - y(180),
      class: 'band',
    }),
    ...[0, 70, 180, 250, 300].map((v) =>
      s('text', { x: PAD.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, String(v)),
    ),
    s('path', { d, class: 'line', fill: 'none' }),
    s('text', { x: PAD.l, y: H - 8, class: 'axis' }, new Date(t0).toISOString().slice(0, 10)),
    s(
      'text',
      { x: W - PAD.r, y: H - 8, 'text-anchor': 'end', class: 'axis' },
      new Date(t1).toISOString().slice(0, 10),
    ),
  );

  // Accessible alternative: daily mean/min/max table.
  const byDay = new Map<string, number[]>();
  for (const p of points) {
    const k = new Date(p.t).toISOString().slice(0, 10);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(p.v);
  }
  const rows = [...byDay].map(([day, vs]) =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, day),
      h('td', {}, String(Math.round(vs.reduce((a, b) => a + b, 0) / vs.length))),
      h('td', {}, String(Math.min(...vs))),
      h('td', {}, String(Math.max(...vs))),
    ),
  );
  const table = h(
    'details',
    { class: 'datatable' },
    h('summary', {}, 'View data table'),
    h(
      'table',
      {},
      h('caption', {}, `${title}: daily mean, minimum and maximum glucose (mg/dL)`),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Day'),
          h('th', { scope: 'col' }, 'Mean'),
          h('th', { scope: 'col' }, 'Min'),
          h('th', { scope: 'col' }, 'Max'),
        ),
      ),
      h('tbody', {}, ...rows),
    ),
  );
  return h('figure', { class: 'figure' }, svg, table);
}

/** Stacked horizontal time-in-ranges bar with a text legend (colour is never the only cue). */
export function tirBar(m: GlucoseMetrics): HTMLElement {
  const bands = [
    { k: 'tbrL2', label: 'Very low (<54)', v: m.tbrL2, cls: 'b-vlow' },
    { k: 'tbrL1', label: 'Low (54–69)', v: m.tbrL1, cls: 'b-low' },
    { k: 'tir', label: 'In range (70–180)', v: m.tir, cls: 'b-in' },
    { k: 'tarL1', label: 'High (181–250)', v: m.tarL1, cls: 'b-high' },
    { k: 'tarL2', label: 'Very high (>250)', v: m.tarL2, cls: 'b-vhigh' },
  ];
  const summary = bands.map((b) => `${b.label} ${b.v.toFixed(1)}%`).join(', ');
  const bar = h(
    'div',
    { class: 'tirbar', role: 'img', 'aria-label': `Time in ranges: ${summary}` },
    ...bands.map((b) => h('span', { class: b.cls, style: `width:${b.v}%` })),
  );
  const legend = h(
    'ul',
    { class: 'legend' },
    ...bands.map((b) =>
      h(
        'li',
        {},
        h('i', { class: b.cls, 'aria-hidden': 'true' }),
        `${b.label}: `,
        h('b', {}, `${b.v.toFixed(1)}%`),
      ),
    ),
  );
  return h('div', {}, bar, legend);
}

/**
 * Daily mean blood pressure: systolic (solid) and diastolic (dashed) lines with reference lines
 * at 130 and 80 mmHg (ACC/AHA stage 1 thresholds), plus a data table with the category per day.
 */
export function bpChart(days: BpDay[], title: string): HTMLElement {
  const yMin = 40;
  const yMax = 200;
  const n = days.length;
  const x = (i: number) => PAD.l + (n > 1 ? i / (n - 1) : 0.5) * (W - PAD.l - PAD.r);
  const y = (v: number) =>
    PAD.t + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const path = (get: (d: BpDay) => number) =>
    days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(get(d)).toFixed(1)}`).join('');
  const refs = [80, 130];
  const svg = s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title, class: 'chart' },
    ...[40, 80, 120, 130, 160, 200].map((v) =>
      s('text', { x: PAD.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, String(v)),
    ),
    ...refs.map((v) => s('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: 'ref' })),
    s('path', { d: path((d) => d.meanSys), class: 'line', fill: 'none' }),
    s('path', { d: path((d) => d.meanDia), class: 'line dashed', fill: 'none' }),
    ...(n
      ? [
          s('text', { x: PAD.l, y: H - 8, class: 'axis' }, days[0]!.day),
          s(
            'text',
            { x: W - PAD.r, y: H - 8, 'text-anchor': 'end', class: 'axis' },
            days[n - 1]!.day,
          ),
        ]
      : []),
  );
  const table = h(
    'details',
    { class: 'datatable' },
    h('summary', {}, 'View data table'),
    h(
      'table',
      {},
      h(
        'caption',
        {},
        `${title}: daily mean blood pressure (mmHg), solid line systolic, dashed diastolic`,
      ),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['Day', 'Readings', 'Systolic', 'Diastolic', 'Category'].map((c) =>
            h('th', { scope: 'col' }, c),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        ...days.map((d) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, d.day),
            h('td', {}, String(d.n)),
            h('td', {}, String(Math.round(d.meanSys))),
            h('td', {}, String(Math.round(d.meanDia))),
            h('td', {}, BP_LABELS[d.category]),
          ),
        ),
      ),
    ),
  );
  return h('figure', { class: 'figure' }, svg, table);
}
