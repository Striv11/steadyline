import type { GlucoseSample } from '../sim/generator';
import { mmolToMgdl } from '../metrics/glucose';
import type { CsvRow } from './csv';

/**
 * CGM CSV importers for Dexcom Clarity and FreeStyle Libre (LibreView) exports.
 *
 * Streaming: rows are consumed one at a time; only the set of already-seen
 * timestamps (numbers) is kept for de-duplication.
 *
 * Timestamps in these exports carry no time zone. `utcOffsetMinutes` says what
 * offset the device clock used (default 0 = treat as UTC); Libre dates are
 * day-first unless `dateOrder: 'mdy'`.
 */
export type CgmFormat = 'dexcom' | 'libre';

export interface CgmImportOptions {
  utcOffsetMinutes?: number;
  dateOrder?: 'dmy' | 'mdy';
  /** Timestamps (epoch ms) already stored; matching rows are skipped as duplicates. */
  existing?: ReadonlySet<number>;
}

export interface RowIssue {
  line: number;
  reason: string;
}

export interface CgmImportReport {
  format: CgmFormat | null;
  rowsRead: number;
  imported: number;
  duplicates: number;
  /** Rows that are valid but not glucose readings (calibrations, insulin, notes...). */
  ignored: number;
  errors: RowIssue[];
  /** Errors beyond this many are counted but not listed. */
  errorsTruncated: number;
}

export const MAX_LISTED_ERRORS = 50;
/** Plausible physiological window for a glucose reading, mg/dL. */
export const GLUCOSE_MIN = 20;
export const GLUCOSE_MAX = 800;

interface Layout {
  format: CgmFormat;
  time: number;
  /** Columns holding glucose, in priority order, with their unit. */
  value: { col: number; mmol: boolean }[];
  /** Dexcom: Event Type column; Libre: Record Type column. */
  kind: number;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Returns a column layout if `fields` is a recognised header row. */
export function detectHeader(fields: string[]): Layout | null {
  const h = fields.map(norm);
  const find = (pred: (s: string) => boolean) => h.findIndex(pred);

  const dxTime = find((s) => s.startsWith('timestamp'));
  const dxVal = find((s) => s.startsWith('glucose value'));
  const dxKind = find((s) => s === 'event type');
  if (dxTime >= 0 && dxVal >= 0 && dxKind >= 0) {
    return {
      format: 'dexcom',
      time: dxTime,
      kind: dxKind,
      value: [{ col: dxVal, mmol: h[dxVal]!.includes('mmol') }],
    };
  }

  const lbTime = find((s) => s === 'device timestamp' || s === 'time');
  const hist = find((s) => s.startsWith('historic glucose'));
  const scan = find((s) => s.startsWith('scan glucose'));
  const lbKind = find((s) => s === 'record type');
  if (lbTime >= 0 && (hist >= 0 || scan >= 0)) {
    const value = [hist, scan]
      .filter((c) => c >= 0)
      .map((c) => ({ col: c, mmol: h[c]!.includes('mmol') }));
    return { format: 'libre', time: lbTime, kind: lbKind, value };
  }
  return null;
}

/** Parse "YYYY-MM-DD[T ]hh:mm[:ss]" or "DD-MM-YYYY hh:mm" (also / and . separators). */
export function parseTimestamp(
  raw: string,
  order: 'dmy' | 'mdy',
  offsetMin: number,
): number | null {
  const s = raw.trim();
  let y: number, mo: number, d: number, rest: string;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](.*))?$/.exec(s);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4] ?? '';
  } else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ](.*))?$/.exec(s);
    if (!m) return null;
    const [a, b] = [Number(m[1]), Number(m[2])];
    [d, mo] = order === 'dmy' ? [a, b] : [b, a];
    y = Number(m[3]);
    rest = m[4] ?? '';
  }
  let hh = 0,
    mi = 0,
    ss = 0;
  if (rest) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(rest.trim());
    if (!t) return null;
    [hh, mi, ss] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null; // e.g. 31 Feb
  return ms - offsetMin * 60_000;
}

/**
 * Consume CSV rows and yield glucose samples. The report object is filled in as
 * rows stream by and is final once the generator completes.
 */
export async function* streamCgm(
  rows: AsyncIterable<CsvRow>,
  report: CgmImportReport,
  opts: CgmImportOptions = {},
): AsyncGenerator<GlucoseSample> {
  const order = opts.dateOrder ?? 'dmy';
  const offset = opts.utcOffsetMinutes ?? 0;
  const seen = new Set<number>();
  let layout: Layout | null = null;

  const fail = (line: number, reason: string) => {
    if (report.errors.length < MAX_LISTED_ERRORS) report.errors.push({ line, reason });
    else report.errorsTruncated++;
  };

  for await (const row of rows) {
    if (!layout) {
      // Libre files have 1-2 preamble lines before the header; look a few rows in.
      if (row.line > 6) {
        break;
      }
      layout = detectHeader(row.fields);
      if (layout) report.format = layout.format;
      continue;
    }
    report.rowsRead++;
    if (row.broken) {
      fail(row.line, 'file ends inside a quoted field');
      continue;
    }
    const f = row.fields;
    if (f.length <= Math.max(layout.time, ...layout.value.map((v) => v.col))) {
      fail(row.line, 'too few columns');
      continue;
    }

    if (layout.format === 'dexcom' && norm(f[layout.kind] ?? '') !== 'egv') {
      report.ignored++;
      continue;
    }
    if (layout.format === 'libre' && layout.kind >= 0) {
      const k = (f[layout.kind] ?? '').trim();
      if (k !== '0' && k !== '1') {
        report.ignored++; // insulin, food, notes
        continue;
      }
    }

    const cell = layout.value.find((v) => (f[v.col] ?? '').trim() !== '');
    if (!cell) {
      if (layout.format === 'libre') report.ignored++;
      else fail(row.line, 'empty glucose value');
      continue;
    }
    const text = f[cell.col]!.trim();
    const num = Number(text.replace(',', '.'));
    if (!Number.isFinite(num)) {
      fail(row.line, `glucose "${text}" is not a number`);
      continue;
    }
    const mgdl = cell.mmol ? mmolToMgdl(num) : num;
    if (mgdl < GLUCOSE_MIN || mgdl > GLUCOSE_MAX) {
      fail(row.line, `glucose ${text} is outside ${GLUCOSE_MIN}-${GLUCOSE_MAX} mg/dL`);
      continue;
    }
    const t = parseTimestamp(f[layout.time] ?? '', order, offset);
    if (t === null) {
      fail(row.line, `unrecognised timestamp "${f[layout.time] ?? ''}"`);
      continue;
    }
    if (seen.has(t) || opts.existing?.has(t)) {
      report.duplicates++;
      continue;
    }
    seen.add(t);
    report.imported++;
    yield { t, mgdl: Math.round(mgdl * 10) / 10 };
  }
}

export function newReport(): CgmImportReport {
  return {
    format: null,
    rowsRead: 0,
    imported: 0,
    duplicates: 0,
    ignored: 0,
    errors: [],
    errorsTruncated: 0,
  };
}

/** Convenience: collect everything (memory grows with the number of samples only). */
export async function importCgm(
  rows: AsyncIterable<CsvRow>,
  opts: CgmImportOptions = {},
): Promise<{ samples: GlucoseSample[]; report: CgmImportReport }> {
  const report = newReport();
  const samples: GlucoseSample[] = [];
  for await (const s of streamCgm(rows, report, opts)) samples.push(s);
  if (!report.format) {
    report.errors.push({ line: 1, reason: 'unrecognised file: no Dexcom or Libre header found' });
  }
  samples.sort((a, b) => a.t - b.t);
  return { samples, report };
}
