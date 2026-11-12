import { describe, expect, it } from 'vitest';
import { parseXml, decodeEntities, decodeStream, type XmlEvent } from './xml';
import {
  importAppleHealth,
  parseAppleDate,
  streamAppleHealth,
  newAppleHealthReport,
} from './applehealth';
import { vitalKey } from './vitals';
import { validateResource } from '../domain/validate';

const chunked = (text: string, n: number) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
};
async function events(chunks: string[]): Promise<XmlEvent[]> {
  const out: XmlEvent[] = [];
  for await (const e of parseXml(chunks)) out.push(e);
  return out;
}

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- comment inside the DTD -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout)*)>
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData locale="en_IN">
 <ExportDate value="2024-02-01 10:00:00 +0530"/>
 <Me HKCharacteristicTypeIdentifierBloodType="HKBloodTypeNotSet"/>
 <!-- a > inside a comment -->
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Alex&apos;s Watch" unit="count/min" startDate="2024-01-05 08:12:00 +0530" value="72"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="lb" startDate="2024-01-05 07:00:00 +0530" value="165"/>
 <Record type="HKQuantityTypeIdentifierOxygenSaturation" unit="%" startDate="2024-01-05 09:00:00 +0530" value="0.97"/>
 <Record type="HKQuantityTypeIdentifierBloodGlucose" unit="mmol&lt;180.1559&gt;/L" startDate="2024-01-05 09:30:00 +0530" value="6.1"/>
 <Record type="HKQuantityTypeIdentifierBodyTemperature" unit="degF" startDate="2024-01-05 10:00:00 +0530" value="100.4"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-05 11:00:00 +0530" value="120"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-05 12:00:00 +0530" value="80"/>
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" startDate="2024-01-05 12:00:00 +0530">
  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" unit="mmHg" startDate="2024-01-05 12:00:00 +0530" value="128"/>
  <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic" unit="mmHg" startDate="2024-01-05 12:00:00 +0530" value="82"/>
 </Correlation>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30"><MetadataEntry key="x" value="a>b"/></Workout>
</HealthData>`;

describe('parseXml', () => {
  it('emits the same events for every chunk size, skipping DTD, comments and text', async () => {
    const whole = await events([FIXTURE]);
    for (const n of [1, 2, 5, 13, 64]) expect(await events(chunked(FIXTURE, n))).toEqual(whole);
    const names = whole.filter((e) => e.type === 'open').map((e) => e.name);
    expect(names.slice(0, 3)).toEqual(['HealthData', 'ExportDate', 'Me']);
    expect(names).toContain('MetadataEntry');
  });
  it('handles > inside quoted attributes and decodes entities', async () => {
    const ev = await events(['<a x="1 > 0" y=\'&lt;b&gt; &#65;&#x42;\'/>']);
    expect(ev).toEqual([
      { type: 'open', name: 'a', attrs: { x: '1 > 0', y: '<b> AB' }, selfClosing: true },
    ]);
    expect(decodeEntities('&bogus; &#0; &amp;')).toBe('&bogus; &#0; &');
  });
  it('flags input that ends inside a tag', async () => {
    const state = { truncated: false };
    for await (const e of parseXml(['<a><b x="1'], state)) void e;
    expect(state.truncated).toBe(true);
  });
  it('decodes a byte stream without splitting multi-byte characters', async () => {
    const bytes = new TextEncoder().encode('<a n="₹₹₹"/>');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 2) c.enqueue(bytes.slice(i, i + 2));
        c.close();
      },
    });
    const ev: XmlEvent[] = [];
    for await (const e of parseXml(decodeStream(stream))) ev.push(e);
    expect(ev[0]).toMatchObject({ attrs: { n: '₹₹₹' } });
  });
});

describe('parseAppleDate', () => {
  it('reads offsets and rejects junk', () => {
    expect(parseAppleDate('2024-01-05 08:12:00 +0530')).toBe(Date.parse('2024-01-05T02:42:00Z'));
    expect(parseAppleDate('2024-01-05 08:12:00 -0800')).toBe(Date.parse('2024-01-05T16:12:00Z'));
    expect(parseAppleDate('yesterday')).toBeNull();
  });
});

describe('importAppleHealth', () => {
  it('maps types and units, pairs BP, counts skipped types', async () => {
    const { observations, report } = await importAppleHealth(chunked(FIXTURE, 40), {
      patientId: 'p1',
    });
    expect(report).toMatchObject({
      recognised: true,
      recordsRead: 9,
      imported: 6,
      duplicates: 0,
      truncated: false,
      cancelled: false,
      errors: [],
    });
    expect(report.skippedTypes).toEqual({ HKQuantityTypeIdentifierStepCount: 2 });
    for (const o of observations) expect(validateResource(o)).toEqual([]);
    const val = (id: string) => observations.find((o) => o.id.startsWith(id))?.valueQuantity?.value;
    expect(val('imp-heartRate')).toBe(72);
    expect(val('imp-weight')).toBe(74.8);
    expect(val('imp-spo2')).toBe(97);
    expect(val('imp-glucose')).toBe(109.9);
    expect(val('imp-temperature')).toBe(38);
    const bp = observations.find((o) => o.id.startsWith('imp-bp'))!;
    expect(bp.component?.map((c) => c.valueQuantity?.value)).toEqual([128, 82]);
    expect(bp.effectiveDateTime).toBe('2024-01-05T06:30:00.000Z');
  });

  it('dedupes against stored keys and repeated records', async () => {
    const t = parseAppleDate('2024-01-05 08:12:00 +0530')!;
    const doubled = FIXTURE.replace(
      '</HealthData>',
      '<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-01-05 08:12:00 +0530" value="72"/></HealthData>',
    );
    const first = await importAppleHealth([doubled], { patientId: 'p1' });
    expect(first.report.imported).toBe(6);
    expect(first.report.duplicates).toBe(1);
    const again = await importAppleHealth([FIXTURE], {
      patientId: 'p1',
      existing: new Set([vitalKey('heartRate', t)]),
    });
    expect(again.report.imported).toBe(5);
    expect(again.report.duplicates).toBe(1);
  });

  it('reports bad records without stopping', async () => {
    const hr = (min: number, extra: string) =>
      `<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-01-05 08:0${min}:00 +0000" ${extra}/>`;
    const bad = `<HealthData>
      <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="nope" value="70"/>
      ${hr(0, 'value="abc"')}
      ${hr(1, 'value="900"')}
      <Record type="HKQuantityTypeIdentifierBodyMass" unit="stone" startDate="2024-01-05 08:02:00 +0000" value="12"/>
      <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" unit="mmHg" startDate="2024-01-05 08:03:00 +0000" value="120"/>
      <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" unit="mmHg" startDate="2024-01-05 08:04:00 +0000" value="70"/>
      <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic" unit="mmHg" startDate="2024-01-05 08:04:00 +0000" value="90"/>
      ${hr(5, 'value="64"')}
    </HealthData>`;
    const { report } = await importAppleHealth([bad], { patientId: 'p1' });
    expect(report.imported).toBe(1);
    const reasons = report.errors.map((e) => e.reason);
    expect(reasons).toHaveLength(6);
    expect(reasons[0]).toContain('unrecognised date');
    expect(reasons.some((r) => r.includes('not a number'))).toBe(true);
    expect(reasons.some((r) => r.includes('outside'))).toBe(true);
    expect(reasons.some((r) => r.includes('unsupported unit'))).toBe(true);
    expect(reasons.some((r) => r.includes('not above diastolic'))).toBe(true);
    expect(reasons.some((r) => r.includes('needs both'))).toBe(true);
  });

  it('rejects files that are not Health exports and flags truncation', async () => {
    const other = await importAppleHealth(['<html><body/></html>'], { patientId: 'p1' });
    expect(other.report.recognised).toBe(false);
    expect(other.report.errors[0]!.reason).toContain('HealthData');
    const cut = await importAppleHealth([FIXTURE.slice(0, 900)], { patientId: 'p1' });
    expect(cut.report.truncated).toBe(true);
    expect(cut.report.imported).toBeGreaterThan(0);
  });

  it('cancels mid-stream and reports progress', async () => {
    const ctl = new AbortController();
    const progress: number[] = [];
    const report = newAppleHealthReport();
    const rec = (i: number) =>
      `<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-01-05 08:${String(i % 60).padStart(2, '0')}:00 +0000" value="${60 + (i % 40)}"/>`;
    const parts = [
      '<HealthData>',
      ...Array.from({ length: 100 }, (_, i) => rec(i)),
      '</HealthData>',
    ];
    let n = 0;
    for await (const o of streamAppleHealth(parts, report, {
      patientId: 'p1',
      signal: ctl.signal,
      onProgress: (c) => progress.push(c),
    })) {
      void o;
      if (++n === 10) ctl.abort();
    }
    expect(report.cancelled).toBe(true);
    expect(n).toBe(10);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('streams 200k records in small chunks', async () => {
    async function* gen() {
      yield '<HealthData>';
      for (let i = 0; i < 200_000; i++) {
        const t = new Date(Date.UTC(2023, 0, 1) + i * 60_000).toISOString();
        const d = `${t.slice(0, 10)} ${t.slice(11, 19)} +0000`;
        yield `<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="${d}" value="${60 + (i % 50)}"/>\n`;
      }
      yield '</HealthData>';
    }
    const report = newAppleHealthReport();
    let count = 0;
    for await (const o of streamAppleHealth(gen(), report, { patientId: 'p1' })) {
      void o;
      count++;
    }
    expect(count).toBe(200_000);
    expect(report.errors).toEqual([]);
  }, 60_000);
});
