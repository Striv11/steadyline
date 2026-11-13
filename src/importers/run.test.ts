import { describe, expect, it } from 'vitest';
import { runImport, sniff, storedKeys, type ChunkSource } from './run';
import { vitalKey } from './vitals';

const src =
  (text: string, n = 7): ChunkSource =>
  () => {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
    return out;
  };

const DEXCOM =
  'Index,Timestamp (YYYY-MM-DDThh:mm:ss),Event Type,Glucose Value (mg/dL)\n' +
  '1,2026-03-05T08:00:00,EGV,100\n2,2026-03-05T08:05:00,EGV,110\n3,2026-03-05T08:10:00,Carbs,\n';
const VITALS = 'Date,Heart rate (bpm),Steps\n2026-03-05 08:00,70,1000\n2026-03-05 09:00,72,2000\n';
const XML = `<?xml version="1.0"?>
<HealthData locale="en_IN">
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-01-05 08:12:00 +0530" value="72"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-05 08:12:00 +0530" value="10"/>
</HealthData>`;

describe('sniff', () => {
  it('recognises each kind, including with a BOM', async () => {
    expect(await sniff(src(DEXCOM))).toBe('cgm');
    expect(await sniff(src('\uFEFF' + DEXCOM))).toBe('cgm');
    expect(await sniff(src(VITALS))).toBe('vitals');
    expect(await sniff(src(XML))).toBe('applehealth');
  });
  it('rejects empty files and unrelated XML', async () => {
    expect(await sniff(src(''))).toBeNull();
    expect(await sniff(src('<html><body/></html>'))).toBeNull();
  });
});

describe('runImport', () => {
  it('imports CGM, ignoring non-glucose rows and deduping against stored keys', async () => {
    const t = Date.UTC(2026, 2, 5, 8, 0, 0);
    const r = await runImport(src(DEXCOM), {
      patientId: 'p1',
      existingKeys: new Set([vitalKey('glucose', t)]),
    });
    expect(r.kind).toBe('cgm');
    expect(r.imported).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(r.glucose.map((s) => s.mgdl)).toEqual([110]);
    expect(r.notes.join()).toMatch(/Ignored 1 non-glucose/);
  });
  it('imports vitals and reports ignored columns', async () => {
    const r = await runImport(src(VITALS), { patientId: 'p1' });
    expect(r.kind).toBe('vitals');
    expect(r.observations).toHaveLength(2);
    expect(r.notes.join()).toMatch(/Steps/i);
  });
  it('imports Apple Health and notes unmapped types', async () => {
    const r = await runImport(src(XML), { patientId: 'p1' });
    expect(r.kind).toBe('applehealth');
    expect(r.imported).toBe(1);
    expect(r.notes.join()).toMatch(/1 records of 1 unmapped/);
  });
  it('honours cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runImport(src(XML), { patientId: 'p1', signal: ac.signal });
    expect(r.cancelled).toBe(true);
  });
  it('explains an unrecognised file', async () => {
    const r = await runImport(src('hello world'), { patientId: 'p1' });
    // Unknown CSV text falls through to the vitals importer, which reports it.
    expect(r.imported).toBe(0);
    expect(r.errors[0]!.reason).toMatch(/unrecognised/);
    const e = await runImport(src(''), { patientId: 'p1' });
    expect(e.kind).toBeNull();
    expect(e.errors[0]!.reason).toMatch(/unrecognised/);
  });
});

describe('storedKeys', () => {
  it('lets a re-import of the same file dedupe against what was saved', async () => {
    const first = await runImport(src(VITALS), { patientId: 'p1' });
    const again = await runImport(src(VITALS), {
      patientId: 'p1',
      existingKeys: storedKeys(first.observations),
    });
    expect(first.imported).toBe(2);
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(2);
  });
});
