import { describe, expect, it } from 'vitest';
import { parseCsv, type CsvRow } from './csv';
import { importCgm, parseTimestamp } from './cgm';

async function rows(text: string, chunk = text.length || 1): Promise<CsvRow[]> {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += chunk) parts.push(text.slice(i, i + chunk));
  const out: CsvRow[] = [];
  for await (const r of parseCsv(parts)) out.push(r);
  return out;
}
async function* gen(text: string) {
  yield* parseCsv([text]);
}

describe('parseCsv', () => {
  it('parses quotes, escaped quotes, embedded newlines and CRLF', async () => {
    const r = await rows('a,"b,1","say ""hi"""\r\nx,"line1\nline2",z\r\n');
    expect(r.map((x) => x.fields)).toEqual([
      ['a', 'b,1', 'say "hi"'],
      ['x', 'line1\nline2', 'z'],
    ]);
    expect(r[1]!.line).toBe(2);
  });
  it('gives identical results for every chunk size', async () => {
    const text = '﻿h1,h2\n1,"a ""q"" b"\r\n\n3,\n4,5';
    const whole = await rows(text);
    for (const n of [1, 2, 3, 7]) expect(await rows(text, n)).toEqual(whole);
    expect(whole.map((x) => x.fields)).toEqual([
      ['h1', 'h2'],
      ['1', 'a "q" b'],
      ['3', ''],
      ['4', '5'],
    ]);
  });
  it('skips blank lines, keeps empty fields, flags unterminated quotes', async () => {
    expect((await rows('a,,c\n\n\nd')).map((x) => x.fields)).toEqual([['a', '', 'c'], ['d']]);
    const broken = await rows('a,"oops\nmore');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.broken).toBe(true);
  });
});

describe('parseTimestamp', () => {
  it('handles ISO, day-first and month-first, offsets and invalid dates', () => {
    expect(parseTimestamp('2026-03-05T08:15:30', 'dmy', 0)).toBe(Date.UTC(2026, 2, 5, 8, 15, 30));
    expect(parseTimestamp('05-03-2026 08:15', 'dmy', 0)).toBe(Date.UTC(2026, 2, 5, 8, 15));
    expect(parseTimestamp('05-03-2026 08:15', 'mdy', 0)).toBe(Date.UTC(2026, 4, 3, 8, 15));
    expect(parseTimestamp('2026-03-05 08:00', 'dmy', 330)).toBe(Date.UTC(2026, 2, 5, 2, 30));
    expect(parseTimestamp('31-02-2026 08:00', 'dmy', 0)).toBeNull();
    expect(parseTimestamp('2026-03-05 25:00', 'dmy', 0)).toBeNull();
    expect(parseTimestamp('yesterday', 'dmy', 0)).toBeNull();
  });
});

const DEXCOM = [
  'Index,Timestamp (YYYY-MM-DDThh:mm:ss),Event Type,Event Subtype,Patient Info,Device Info,Source Device ID,Glucose Value (mg/dL),Insulin Value (u)',
  '1,,FirstName,,,,,,',
  '2,2026-03-05T08:00:00,EGV,,,,G6,110,',
  '3,2026-03-05T08:05:00,EGV,,,,G6,Low,',
  '4,2026-03-05T08:10:00,Calibration,,,,G6,100,',
  '5,2026-03-05T08:15:00,EGV,,,,G6,125,',
  '6,2026-03-05T08:15:00,EGV,,,,G6,125,',
  '7,not-a-time,EGV,,,,G6,130,',
  '8,2026-03-05T08:20:00,EGV,,,,G6,9999,',
  '9,2026-03-05T08:25:00,EGV',
].join('\n');

describe('importCgm: Dexcom', () => {
  it('imports EGV rows and reports every problem with its line', async () => {
    const { samples, report } = await importCgm(gen(DEXCOM));
    expect(report.format).toBe('dexcom');
    expect(samples.map((s) => s.mgdl)).toEqual([110, 125]);
    expect(report.imported).toBe(2);
    expect(report.duplicates).toBe(1);
    expect(report.ignored).toBe(2); // FirstName + Calibration
    expect(report.errors.map((e) => e.line)).toEqual([4, 8, 9, 10]);
    expect(report.errors[0]!.reason).toMatch(/"Low" is not a number/);
    expect(report.errors[1]!.reason).toMatch(/unrecognised timestamp/);
    expect(report.errors[2]!.reason).toMatch(/outside/);
    expect(report.errors[3]!.reason).toMatch(/too few columns/);
  });

  it('skips readings already stored on re-import', async () => {
    const first = await importCgm(gen(DEXCOM));
    const existing = new Set(first.samples.map((s) => s.t));
    const again = await importCgm(gen(DEXCOM), { existing });
    expect(again.samples).toEqual([]);
    expect(again.report.duplicates).toBe(3);
  });
});

describe('importCgm: Libre', () => {
  const LIBRE = [
    'Glucose Data,Generated on,05-03-2026 10:00,Printed by,x',
    'Device,Serial Number,Device Timestamp,Record Type,Historic Glucose mg/dL,Scan Glucose mg/dL,Non-numeric Rapid-Acting Insulin',
    'FreeStyle LibreLink,ABC,05-03-2026 08:00,0,100,,',
    'FreeStyle LibreLink,ABC,05-03-2026 08:12,1,,140,',
    'FreeStyle LibreLink,ABC,05-03-2026 08:20,4,,,2',
    'FreeStyle LibreLink,ABC,05-03-2026 08:30,0,,,',
  ].join('\n');

  it('skips the preamble, takes historic and scan values, ignores other record types', async () => {
    const { samples, report } = await importCgm(gen(LIBRE));
    expect(report.format).toBe('libre');
    expect(samples).toEqual([
      { t: Date.UTC(2026, 2, 5, 8, 0), mgdl: 100 },
      { t: Date.UTC(2026, 2, 5, 8, 12), mgdl: 140 },
    ]);
    expect(report.ignored).toBe(2);
    expect(report.errors).toEqual([]);
  });

  it('converts mmol/L columns and honours month-first dates', async () => {
    const text = 'Device Timestamp,Record Type,Historic Glucose mmol/L\n03-05-2026 08:00,0,5.5\n';
    const { samples } = await importCgm(gen(text), { dateOrder: 'mdy' });
    expect(samples[0]!.t).toBe(Date.UTC(2026, 2, 5, 8, 0));
    expect(samples[0]!.mgdl).toBeCloseTo(99.1, 1);
  });
});

describe('importCgm: robustness', () => {
  it('rejects an unrecognised file clearly', async () => {
    const { samples, report } = await importCgm(gen('a,b\n1,2\n'));
    expect(samples).toEqual([]);
    expect(report.errors[0]!.reason).toMatch(/unrecognised file/);
  });

  it('streams 100k rows from small chunks, with errors capped', async () => {
    async function* chunks() {
      yield 'Timestamp (YYYY-MM-DDThh:mm:ss),Event Type,Glucose Value (mg/dL)\n';
      const base = Date.UTC(2026, 0, 1);
      for (let i = 0; i < 100_000; i++) {
        const iso = new Date(base + i * 300_000).toISOString().slice(0, 19);
        yield i % 1000 === 7 ? `${iso},EGV,oops\n` : `${iso},EGV,${80 + (i % 90)}\n`;
      }
    }
    const report = (await importCgm(parseCsv(chunks()))).report;
    expect(report.rowsRead).toBe(100_000);
    expect(report.imported).toBe(99_900);
    expect(report.errors.length + report.errorsTruncated).toBe(100);
    expect(report.errors.length).toBe(50);
  });
});

describe('importVitals (Google Fit / Health Connect CSV)', () => {
  const opts = { patientId: 'p1' };
  it('maps columns to validated observations, ignoring unrelated ones', async () => {
    const { importVitals } = await import('./vitals');
    const csv =
      'Date,Step count,Average heart rate (bpm),Average weight (lb),Systolic (mmHg),Diastolic (mmHg)\n' +
      '2026-03-01,8000,72,176,128,82\n' +
      '2026-03-02,5000,,,,\n';
    const { observations, report } = await importVitals(gen(csv), opts);
    expect(report.recognised).toBe(true);
    expect(report.ignoredColumns).toEqual(['Step count']);
    expect(observations).toHaveLength(3);
    const weight = observations.find((o) => o.id.startsWith('imp-weight'))!;
    expect(weight.valueQuantity!.value).toBeCloseTo(79.8, 1);
    expect(observations.some((o) => o.id.startsWith('imp-bp'))).toBe(true);
    expect(report.rowsRead).toBe(2);
  });
  it('reports bad rows by line and de-duplicates against stored keys', async () => {
    const { importVitals, vitalKey } = await import('./vitals');
    const t = Date.UTC(2026, 2, 1);
    const csv =
      'Date,Heart rate (bpm),Systolic (mmHg),Diastolic (mmHg)\n' +
      '2026-03-01,70,,\n' + // duplicate of stored
      '2026-03-02,900,,\n' + // out of range
      'nonsense,70,,\n' +
      '2026-03-04,,120,\n' + // half a BP
      '2026-03-05,,80,120\n' + // inverted
      '2026-03-06,61,,\n';
    const { observations, report } = await importVitals(gen(csv), {
      ...opts,
      existing: new Set([vitalKey('heartRate', t)]),
    });
    expect(observations).toHaveLength(1);
    expect(report.duplicates).toBe(1);
    expect(report.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
  });
  it('rejects unknown files and converts mmol/L and °F', async () => {
    const { importVitals } = await import('./vitals');
    const bad = await importVitals(gen('foo,bar\n1,2\n'), opts);
    expect(bad.report.recognised).toBe(false);
    expect(bad.report.errors).toHaveLength(1);
    const ok = await importVitals(
      gen('Time,Glucose (mmol/L),Temperature (°F)\n2026-03-01 08:00,5.5,98.6\n'),
      opts,
    );
    const vals = Object.fromEntries(
      ok.observations.map((o) => [o.id.split('-')[1], o.valueQuantity!.value]),
    );
    expect(vals['glucose']).toBeCloseTo(99.1, 1);
    expect(vals['temperature']).toBeCloseTo(37, 1);
  });
});
