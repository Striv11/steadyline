import { describe, expect, it } from 'vitest';
import { bpReadings, classifyBp, dailyBp, summarizeBp, type BpCategory } from './bp';
import { makeBloodPressure, makeVital } from '../domain/builders';

describe('classifyBp (ACC/AHA 2017 Table 6)', () => {
  const cases: [number, number, BpCategory][] = [
    [119, 79, 'normal'],
    [90, 60, 'normal'],
    [120, 79, 'elevated'],
    [129, 79, 'elevated'],
    [129, 80, 'stage1'], // diastolic alone moves up a category
    [130, 79, 'stage1'],
    [139, 89, 'stage1'],
    [119, 80, 'stage1'],
    [140, 79, 'stage2'],
    [139, 90, 'stage2'],
    [120, 89, 'stage1'],
    [150, 95, 'stage2'],
    [180, 120, 'stage2'], // crisis needs to exceed 180 / 120
    [181, 80, 'crisis'],
    [150, 121, 'crisis'],
  ];
  it.each(cases)('%i/%i is %s', (s, d, expected) => {
    expect(classifyBp(s, d)).toBe(expected);
  });
});

const at = (iso: string) => iso;

describe('readings and summaries', () => {
  const obs = [
    makeBloodPressure('b2', 'p', 142, 88, at('2026-10-02T08:00:00Z')),
    makeBloodPressure('b1', 'p', 118, 76, at('2026-10-01T08:00:00Z')),
    makeBloodPressure('b3', 'p', 126, 78, at('2026-10-02T20:00:00Z')),
    makeVital('hr1', 'p', 'heartRate', 70, at('2026-10-01T08:00:00Z')),
  ];

  it('extracts BP panels only, sorted by time', () => {
    const r = bpReadings(obs);
    expect(r.map((x) => [x.sys, x.dia])).toEqual([
      [118, 76],
      [142, 88],
      [126, 78],
    ]);
  });

  it('ignores panels with missing components or bad dates', () => {
    const broken = makeBloodPressure('x', 'p', 120, 80, at('2026-10-01T08:00:00Z'));
    broken.component = broken.component!.slice(0, 1);
    const badDate = makeBloodPressure('y', 'p', 120, 80, 'not-a-date');
    expect(bpReadings([broken, badDate])).toEqual([]);
  });

  it('summarizes mean, category, shares and worst reading', () => {
    const s = summarizeBp(bpReadings(obs))!;
    expect(s.n).toBe(3);
    expect(s.meanSys).toBeCloseTo(128.67, 2);
    expect(s.meanDia).toBeCloseTo(80.67, 2);
    expect(s.category).toBe('stage1'); // 129/81 → diastolic 80-89
    expect(s.worst).toBe('stage2');
    expect(s.share.normal).toBeCloseTo(33.33, 1);
    expect(Object.values(s.share).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });

  it('returns null with no readings', () => {
    expect(summarizeBp([])).toBeNull();
  });

  it('averages per UTC day in order', () => {
    const d = dailyBp(bpReadings(obs));
    expect(d.map((x) => x.day)).toEqual(['2026-10-01', '2026-10-02']);
    expect(d[1]).toMatchObject({ n: 2, meanSys: 134, meanDia: 83, category: 'stage1' });
  });
});
