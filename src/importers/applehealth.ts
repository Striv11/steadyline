import type { Observation } from '../domain/fhir';
import { VITALS } from '../domain/codes';
import { makeBloodPressure, makeVital } from '../domain/builders';
import { validateResource } from '../domain/validate';
import { MAX_LISTED_ERRORS, type RowIssue } from './cgm';
import { vitalKey } from './vitals';
import { parseXml, type XmlEvent, type XmlState } from './xml';

/**
 * Apple Health `export.xml` importer. Streams `<Record>` elements, maps the
 * HealthKit quantity types we model to LOINC-coded FHIR Observations and
 * counts everything else as skipped (steps, energy, workouts...). Systolic and
 * diastolic records with the same start time are paired into one BP panel.
 * Supports cancellation (AbortSignal) and progress callbacks.
 */
export interface AppleHealthOptions {
  patientId: string;
  /** Keys already stored, as produced by `vitalKey`; matching records are skipped. */
  existing?: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Called after each input chunk with the number of characters read so far. */
  onProgress?: (charsRead: number) => void;
}

export interface AppleHealthReport {
  recordsRead: number;
  imported: number;
  duplicates: number;
  /** Count of records per unmapped HealthKit type. */
  skippedTypes: Record<string, number>;
  errors: RowIssue[];
  errorsTruncated: number;
  charsRead: number;
  cancelled: boolean;
  /** The file ended inside an element: it was cut off or is not a complete export. */
  truncated: boolean;
  /** At least one <HealthData> root element was seen. */
  recognised: boolean;
}

export function newAppleHealthReport(): AppleHealthReport {
  return {
    recordsRead: 0,
    imported: 0,
    duplicates: 0,
    skippedTypes: {},
    errors: [],
    errorsTruncated: 0,
    charsRead: 0,
    cancelled: false,
    truncated: false,
    recognised: false,
  };
}

type Kind =
  | 'heartRate'
  | 'weight'
  | 'spo2'
  | 'glucose'
  | 'temperature'
  | 'peakFlow'
  | 'systolic'
  | 'diastolic';

const PREFIX = 'HKQuantityTypeIdentifier';
const TYPES: Record<string, Kind> = {
  HeartRate: 'heartRate',
  BodyMass: 'weight',
  OxygenSaturation: 'spo2',
  BloodGlucose: 'glucose',
  BodyTemperature: 'temperature',
  PeakExpiratoryFlowRate: 'peakFlow',
  BloodPressureSystolic: 'systolic',
  BloodPressureDiastolic: 'diastolic',
};

/** Convert a HealthKit value+unit to the app's unit, or null if the unit is unknown. */
function convert(kind: Kind, value: number, unit: string): number | null {
  const u = unit.trim();
  switch (kind) {
    case 'heartRate':
      return u === 'count/min' ? value : null;
    case 'weight':
      if (u === 'kg') return value;
      if (u === 'lb') return value * 0.45359237;
      if (u === 'g') return value / 1000;
      return null;
    case 'spo2':
      // HealthKit stores a fraction with unit "%": 0.97 means 97 %.
      if (u === '%') return value <= 1 ? value * 100 : value;
      return null;
    case 'glucose':
      if (u === 'mg/dL') return value;
      if (/^mmol(<[\d.]+>)?\/L$/.test(u)) return value * 18.0156;
      return null;
    case 'temperature':
      if (u === 'degC') return value;
      if (u === 'degF') return ((value - 32) * 5) / 9;
      return null;
    case 'peakFlow':
      return u === 'L/min' ? value : null;
    case 'systolic':
    case 'diastolic':
      return u === 'mmHg' ? value : null;
  }
}

/** "2024-01-05 08:12:00 +0530" -> epoch ms (null if malformed). */
export function parseAppleDate(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/.exec(
    s.trim(),
  );
  if (!m) return null;
  let tz = m[3] ?? 'Z';
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(t) ? null : t;
}

export async function* streamAppleHealth(
  chunks: Iterable<string> | AsyncIterable<string>,
  report: AppleHealthReport,
  opts: AppleHealthOptions,
): AsyncGenerator<Observation> {
  const seen = new Set<string>();
  const pending = new Map<number, { sys?: number; dia?: number }>();
  const state: XmlState = { truncated: false };
  let recordNo = 0;

  const fail = (reason: string) => {
    if (report.errors.length < MAX_LISTED_ERRORS) report.errors.push({ line: recordNo, reason });
    else report.errorsTruncated++;
  };

  // Count characters as they flow through so progress works for any source.
  async function* counted(): AsyncGenerator<string> {
    for await (const c of chunks) {
      report.charsRead += c.length;
      opts.onProgress?.(report.charsRead);
      yield c;
    }
  }

  const emit = (key: string, make: () => Observation): Observation | null => {
    if (seen.has(key) || opts.existing?.has(key)) {
      report.duplicates++;
      return null;
    }
    const obs = make();
    const problems = validateResource(obs);
    if (problems.length > 0) {
      fail(`invalid observation: ${problems[0]!.message}`);
      return null;
    }
    seen.add(key);
    report.imported++;
    return obs;
  };

  const handle = (ev: XmlEvent): Observation | null => {
    if (ev.type !== 'open') return null;
    if (ev.name === 'HealthData') report.recognised = true;
    if (ev.name !== 'Record') return null;
    report.recordsRead++;
    recordNo++;
    const type = ev.attrs['type'] ?? '';
    const kind = type.startsWith(PREFIX) ? TYPES[type.slice(PREFIX.length)] : undefined;
    if (!kind) {
      report.skippedTypes[type || '(none)'] = (report.skippedTypes[type || '(none)'] ?? 0) + 1;
      return null;
    }
    const t = parseAppleDate(ev.attrs['startDate'] ?? '');
    if (t === null) {
      fail(`unrecognised date "${ev.attrs['startDate'] ?? ''}"`);
      return null;
    }
    const raw = Number(ev.attrs['value']);
    if (ev.attrs['value'] === undefined || ev.attrs['value'] === '' || !Number.isFinite(raw)) {
      fail(`"${ev.attrs['value'] ?? ''}" is not a number`);
      return null;
    }
    const converted = convert(kind, raw, ev.attrs['unit'] ?? '');
    if (converted === null) {
      fail(`unsupported unit "${ev.attrs['unit'] ?? ''}" for ${VITALS[kind]!.label}`);
      return null;
    }
    const v = Math.round(converted * 10) / 10;
    const def = VITALS[kind]!;
    if (v < def.min || v > def.max) {
      fail(`${def.label} ${v} is outside ${def.min}-${def.max} ${def.unit}`);
      return null;
    }
    const at = new Date(t).toISOString();
    if (kind === 'systolic' || kind === 'diastolic') {
      const slot = pending.get(t) ?? {};
      if (kind === 'systolic') slot.sys = v;
      else slot.dia = v;
      if (slot.sys === undefined || slot.dia === undefined) {
        pending.set(t, slot);
        return null;
      }
      pending.delete(t);
      if (slot.sys <= slot.dia) {
        fail(`systolic ${slot.sys} is not above diastolic ${slot.dia}`);
        return null;
      }
      const { sys, dia } = slot;
      return emit(vitalKey('bp', t), () =>
        makeBloodPressure(`imp-bp-${t}`, opts.patientId, sys, dia, at),
      );
    }
    return emit(vitalKey(kind, t), () =>
      makeVital(`imp-${kind}-${t}`, opts.patientId, kind, v, at),
    );
  };

  for await (const ev of parseXml(counted(), state)) {
    if (opts.signal?.aborted) {
      report.cancelled = true;
      return;
    }
    const obs = handle(ev);
    if (obs) yield obs;
  }
  if (opts.signal?.aborted) report.cancelled = true;
  report.truncated = state.truncated;
  for (const t of pending.keys()) {
    recordNo = 0;
    fail(`blood pressure at ${new Date(t).toISOString()} needs both systolic and diastolic`);
  }
}

export async function importAppleHealth(
  chunks: Iterable<string> | AsyncIterable<string>,
  opts: AppleHealthOptions,
): Promise<{ observations: Observation[]; report: AppleHealthReport }> {
  const report = newAppleHealthReport();
  const observations: Observation[] = [];
  for await (const o of streamAppleHealth(chunks, report, opts)) observations.push(o);
  if (!report.recognised && !report.cancelled) {
    report.errors.push({ line: 1, reason: 'unrecognised file: no <HealthData> element found' });
  }
  return { observations, report };
}
