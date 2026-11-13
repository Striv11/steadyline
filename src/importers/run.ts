import type { Observation } from '../domain/fhir';
import type { GlucoseSample } from '../sim/generator';
import { importCgm, detectHeader, type CgmImportOptions, type RowIssue } from './cgm';
import { parseCsv } from './csv';
import { importVitals, vitalKey } from './vitals';
import { LOINC_BP_PANEL, LOINC_TO_VITAL } from '../domain/codes';
import { importAppleHealth } from './applehealth';

/**
 * One entry point for the import screen: sniff what kind of export a file is,
 * run the matching streaming importer and return a uniform summary. The
 * source is a factory so the sniffed prefix can be read from a fresh stream
 * (`() => decodeStream(file.stream())`) instead of buffering the whole file.
 */
export type ImportKind = 'applehealth' | 'cgm' | 'vitals';
export type ChunkSource = () => Iterable<string> | AsyncIterable<string>;

export interface RunOptions extends CgmImportOptions {
  patientId: string;
  /** Stored vital keys (`vitalKey`) for Observation dedupe. */
  existingKeys?: ReadonlySet<string>;
  signal?: AbortSignal;
  onProgress?: (charsRead: number) => void;
}

export interface ImportOutcome {
  kind: ImportKind | null;
  observations: Observation[];
  glucose: GlucoseSample[];
  read: number;
  imported: number;
  duplicates: number;
  /** Human-readable notes: ignored columns, unmapped types, truncation... */
  notes: string[];
  errors: RowIssue[];
  errorsTruncated: number;
  cancelled: boolean;
}

const SNIFF_CHARS = 64 * 1024;
const SNIFF_ROWS = 40;

async function head(source: ChunkSource): Promise<string> {
  let s = '';
  for await (const c of source()) {
    s += c;
    if (s.length >= SNIFF_CHARS) break;
  }
  return s.replace(/^\uFEFF/, '').slice(0, SNIFF_CHARS);
}

/** Classify a file from its first 64 KB. Returns null if nothing is recognisable. */
export async function sniff(source: ChunkSource): Promise<ImportKind | null> {
  const text = await head(source);
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) return /<HealthData[\s>]/.test(text) ? 'applehealth' : null;
  let n = 0;
  for await (const row of parseCsv([text])) {
    if (detectHeader(row.fields)) return 'cgm';
    if (++n >= SNIFF_ROWS) break;
  }
  return trimmed.length > 0 ? 'vitals' : null;
}

async function* rowsOf(source: ChunkSource) {
  yield* parseCsv(source());
}

export async function runImport(source: ChunkSource, opts: RunOptions): Promise<ImportOutcome> {
  const empty: ImportOutcome = {
    kind: null,
    observations: [],
    glucose: [],
    read: 0,
    imported: 0,
    duplicates: 0,
    notes: [],
    errors: [],
    errorsTruncated: 0,
    cancelled: false,
  };
  const kind = await sniff(source);
  if (!kind) {
    return {
      ...empty,
      errors: [
        {
          line: 1,
          reason: 'unrecognised file: expected a CGM CSV, vitals CSV or Apple Health export.xml',
        },
      ],
    };
  }
  if (kind === 'applehealth') {
    const { observations, report } = await importAppleHealth(source(), {
      patientId: opts.patientId,
      ...(opts.existingKeys && { existing: opts.existingKeys }),
      ...(opts.signal && { signal: opts.signal }),
      ...(opts.onProgress && { onProgress: opts.onProgress }),
    });
    const notes: string[] = [];
    const skipped = Object.entries(report.skippedTypes);
    if (skipped.length) {
      notes.push(
        `Skipped ${skipped.reduce((a, [, c]) => a + c, 0)} records of ${skipped.length} unmapped types`,
      );
    }
    if (report.truncated) notes.push('The file looks cut off; only complete records were imported');
    return {
      ...empty,
      kind,
      observations,
      read: report.recordsRead,
      imported: report.imported,
      duplicates: report.duplicates,
      notes,
      errors: report.errors,
      errorsTruncated: report.errorsTruncated,
      cancelled: report.cancelled,
    };
  }
  if (kind === 'cgm') {
    const existing = new Set<number>();
    for (const k of opts.existingKeys ?? []) {
      const m = /^glucose@(\d+)$/.exec(k);
      if (m) existing.add(Number(m[1]));
    }
    const { samples, report } = await importCgm(rowsOf(source), { ...opts, existing });
    const notes = report.ignored ? [`Ignored ${report.ignored} non-glucose rows`] : [];
    return {
      ...empty,
      kind,
      glucose: samples,
      read: report.rowsRead,
      imported: report.imported,
      duplicates: report.duplicates,
      notes,
      errors: report.errors,
      errorsTruncated: report.errorsTruncated,
    };
  }
  const { observations, report } = await importVitals(rowsOf(source), {
    patientId: opts.patientId,
    ...(opts.utcOffsetMinutes !== undefined && { utcOffsetMinutes: opts.utcOffsetMinutes }),
    ...(opts.dateOrder && { dateOrder: opts.dateOrder }),
    ...(opts.existingKeys && { existing: opts.existingKeys }),
  });
  const notes = report.ignoredColumns.length
    ? [`Ignored columns: ${report.ignoredColumns.join(', ')}`]
    : [];
  return {
    ...empty,
    kind,
    observations,
    read: report.rowsRead,
    imported: report.imported,
    duplicates: report.duplicates,
    notes,
    errors: report.errors,
    errorsTruncated: report.errorsTruncated,
  };
}

/** Dedupe keys (`vitalKey` format) for Observations already in the vault. */
export function storedKeys(observations: Iterable<Observation>): Set<string> {
  const keys = new Set<string>();
  for (const o of observations) {
    const t = o.effectiveDateTime ? Date.parse(o.effectiveDateTime) : NaN;
    if (Number.isNaN(t)) continue;
    for (const c of o.code.coding ?? []) {
      if (c.code === LOINC_BP_PANEL) keys.add(vitalKey('bp', t));
      else if (c.code && LOINC_TO_VITAL[c.code]) keys.add(vitalKey(LOINC_TO_VITAL[c.code]!.key, t));
    }
  }
  return keys;
}
