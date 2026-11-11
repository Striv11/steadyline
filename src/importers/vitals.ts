import type { Observation } from '../domain/fhir';
import { VITALS } from '../domain/codes';
import { makeBloodPressure, makeVital } from '../domain/builders';
import { validateResource } from '../domain/validate';
import { MAX_LISTED_ERRORS, parseTimestamp, type RowIssue } from './cgm';
import type { CsvRow } from './csv';

/**
 * Vitals CSV importer for Google Fit (Takeout daily metrics) and Health
 * Connect style exports. These are wide tables: one date/time column plus one
 * column per measurement, with units in the header, e.g.
 *   Date,Average heart rate (bpm),Average weight (kg),Systolic (mmHg),Diastolic (mmHg)
 * Columns are recognised by name; unknown columns (steps, calories...) are
 * ignored and listed in the report. Empty cells are skipped, out-of-range
 * values are reported per row, and rows are de-duplicated by (kind, time).
 */
export interface VitalsImportOptions {
  patientId: string;
  utcOffsetMinutes?: number;
  dateOrder?: 'dmy' | 'mdy';
  /** Keys already stored, as produced by `vitalKey`; matching rows are skipped. */
  existing?: ReadonlySet<string>;
}

export interface VitalsImportReport {
  recognised: boolean;
  columns: string[];
  ignoredColumns: string[];
  rowsRead: number;
  imported: number;
  duplicates: number;
  errors: RowIssue[];
  errorsTruncated: number;
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

const norm = (s: string) => s.trim().toLowerCase();

function classify(header: string): { kind: Kind; scale: (n: number) => number } | null {
  const h = norm(header);
  const id = (n: number) => n;
  if (/systolic/.test(h)) return { kind: 'systolic', scale: id };
  if (/diastolic/.test(h)) return { kind: 'diastolic', scale: id };
  if (/heart rate|pulse/.test(h) && !/max|min|variab/.test(h))
    return { kind: 'heartRate', scale: id };
  if (/weight/.test(h)) {
    if (/\blb|pound/.test(h)) return { kind: 'weight', scale: (n) => n * 0.45359237 };
    return { kind: 'weight', scale: id };
  }
  if (/spo2|spo₂|oxygen saturation/.test(h)) return { kind: 'spo2', scale: id };
  if (/glucose/.test(h)) {
    if (/mmol/.test(h)) return { kind: 'glucose', scale: (n) => n * 18.0156 };
    return { kind: 'glucose', scale: id };
  }
  if (/temperature/.test(h)) {
    if (/°f|\(f\)|fahrenheit/.test(h))
      return { kind: 'temperature', scale: (n) => ((n - 32) * 5) / 9 };
    return { kind: 'temperature', scale: id };
  }
  if (/peak flow/.test(h)) return { kind: 'peakFlow', scale: id };
  return null;
}

const isTimeHeader = (h: string) =>
  /^(date|time|timestamp|start time|start|date ?& ?time|datetime)$/.test(norm(h));

/** Stable identity of one imported measurement, for de-duplication against stored data. */
export const vitalKey = (kind: string, t: number) => `${kind}@${t}`;

export function newVitalsReport(): VitalsImportReport {
  return {
    recognised: false,
    columns: [],
    ignoredColumns: [],
    rowsRead: 0,
    imported: 0,
    duplicates: 0,
    errors: [],
    errorsTruncated: 0,
  };
}

export async function* streamVitals(
  rows: AsyncIterable<CsvRow>,
  report: VitalsImportReport,
  opts: VitalsImportOptions,
): AsyncGenerator<Observation> {
  const order = opts.dateOrder ?? 'dmy';
  const offset = opts.utcOffsetMinutes ?? 0;
  const seen = new Set<string>();
  let timeCol = -1;
  let cols: { col: number; kind: Kind; scale: (n: number) => number }[] = [];
  let header = true;

  const fail = (line: number, reason: string) => {
    if (report.errors.length < MAX_LISTED_ERRORS) report.errors.push({ line, reason });
    else report.errorsTruncated++;
  };

  for await (const row of rows) {
    if (header) {
      header = false;
      timeCol = row.fields.findIndex(isTimeHeader);
      cols = [];
      row.fields.forEach((f, col) => {
        if (col === timeCol) return;
        const c = classify(f);
        if (c) cols.push({ col, ...c });
        else if (f.trim()) report.ignoredColumns.push(f.trim());
      });
      report.recognised = timeCol >= 0 && cols.length > 0;
      report.columns = cols.map((c) => c.kind);
      if (!report.recognised) return;
      continue;
    }
    report.rowsRead++;
    if (row.broken) {
      fail(row.line, 'file ends inside a quoted field');
      continue;
    }
    const t = parseTimestamp(row.fields[timeCol] ?? '', order, offset);
    if (t === null) {
      fail(row.line, `unrecognised date "${row.fields[timeCol] ?? ''}"`);
      continue;
    }
    const at = new Date(t).toISOString();
    const values = new Map<Kind, number>();
    for (const c of cols) {
      const text = (row.fields[c.col] ?? '').trim();
      if (text === '') continue;
      const num = Number(text.replace(',', '.'));
      if (!Number.isFinite(num)) {
        fail(row.line, `"${text}" is not a number`);
        continue;
      }
      const v = Math.round(c.scale(num) * 10) / 10;
      const def = VITALS[c.kind]!;
      if (v < def.min || v > def.max) {
        fail(row.line, `${def.label} ${text} is outside ${def.min}-${def.max} ${def.unit}`);
        continue;
      }
      values.set(c.kind, v);
    }

    const out: { key: string; make: () => Observation }[] = [];
    const sys = values.get('systolic');
    const dia = values.get('diastolic');
    if (sys !== undefined && dia !== undefined) {
      if (sys <= dia) fail(row.line, `systolic ${sys} is not above diastolic ${dia}`);
      else
        out.push({
          key: vitalKey('bp', t),
          make: () => makeBloodPressure(`imp-bp-${t}`, opts.patientId, sys, dia, at),
        });
    } else if (sys !== undefined || dia !== undefined) {
      fail(row.line, 'blood pressure needs both systolic and diastolic');
    }
    for (const [kind, v] of values) {
      if (kind === 'systolic' || kind === 'diastolic') continue;
      out.push({
        key: vitalKey(kind, t),
        make: () => makeVital(`imp-${kind}-${t}`, opts.patientId, kind, v, at),
      });
    }

    for (const o of out) {
      if (seen.has(o.key) || opts.existing?.has(o.key)) {
        report.duplicates++;
        continue;
      }
      const obs = o.make();
      const problems = validateResource(obs);
      if (problems.length > 0) {
        fail(row.line, `invalid observation: ${problems[0]!.message}`);
        continue;
      }
      seen.add(o.key);
      report.imported++;
      yield obs;
    }
  }
}

export async function importVitals(
  rows: AsyncIterable<CsvRow>,
  opts: VitalsImportOptions,
): Promise<{ observations: Observation[]; report: VitalsImportReport }> {
  const report = newVitalsReport();
  const observations: Observation[] = [];
  for await (const o of streamVitals(rows, report, opts)) observations.push(o);
  if (!report.recognised) {
    report.errors.push({
      line: 1,
      reason: 'unrecognised file: need a date column and at least one known measurement column',
    });
  }
  return { observations, report };
}
