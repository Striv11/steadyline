import type { Bundle, Observation, Resource } from './fhir';
import { LOINC_BP_PANEL, LOINC_TO_VITAL, SYSTEM_LOINC } from './codes';

export interface Issue {
  path: string;
  message: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const TYPES = new Set([
  'Patient',
  'Condition',
  'Observation',
  'MedicationStatement',
  'MedicationAdministration',
]);

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validDate(s: unknown): boolean {
  return typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s));
}

function checkRef(ref: unknown, path: string, issues: Issue[]) {
  if (
    !isObj(ref) ||
    typeof ref['reference'] !== 'string' ||
    !/^Patient\/.+/.test(ref['reference'])
  ) {
    issues.push({ path, message: 'must be a reference like "Patient/<id>"' });
  }
}

function checkQuantityRange(
  code: string | undefined,
  value: unknown,
  path: string,
  issues: Issue[],
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: 'value must be a finite number' });
    return;
  }
  const def = code ? LOINC_TO_VITAL[code] : undefined;
  if (def && (value < def.min || value > def.max)) {
    issues.push({
      path,
      message: `${def.label} ${value} ${def.unit} is outside the plausible range ${def.min}–${def.max}`,
    });
  }
}

function loincOf(concept: unknown): string | undefined {
  if (!isObj(concept) || !Array.isArray(concept['coding'])) return undefined;
  for (const c of concept['coding']) {
    if (isObj(c) && c['system'] === SYSTEM_LOINC && typeof c['code'] === 'string') return c['code'];
  }
  return undefined;
}

function validateObservation(o: Record<string, unknown>, p: string, issues: Issue[]) {
  if (!['final', 'preliminary', 'amended'].includes(String(o['status']))) {
    issues.push({ path: `${p}.status`, message: 'invalid status' });
  }
  if (!isObj(o['code'])) issues.push({ path: `${p}.code`, message: 'required' });
  if (!validDate(o['effectiveDateTime'])) {
    issues.push({ path: `${p}.effectiveDateTime`, message: 'must be an ISO 8601 date/time' });
  }
  const code = loincOf(o['code']);
  const vq = o['valueQuantity'];
  const comps = o['component'];
  if (code === LOINC_BP_PANEL) {
    if (!Array.isArray(comps) || comps.length !== 2) {
      issues.push({
        path: `${p}.component`,
        message: 'BP panel needs systolic and diastolic components',
      });
    } else {
      let sys: number | undefined;
      let dia: number | undefined;
      comps.forEach((c, i) => {
        const cc = isObj(c) ? c : {};
        const cCode = loincOf(cc['code']);
        const v = isObj(cc['valueQuantity']) ? cc['valueQuantity']['value'] : undefined;
        checkQuantityRange(cCode, v, `${p}.component[${i}].valueQuantity.value`, issues);
        if (cCode === '8480-6') sys = v as number;
        if (cCode === '8462-4') dia = v as number;
      });
      if (sys === undefined || dia === undefined) {
        issues.push({
          path: `${p}.component`,
          message: 'missing systolic (8480-6) or diastolic (8462-4)',
        });
      } else if (sys <= dia) {
        issues.push({ path: `${p}.component`, message: 'systolic must be greater than diastolic' });
      }
    }
  } else if (vq !== undefined) {
    checkQuantityRange(
      code,
      isObj(vq) ? vq['value'] : undefined,
      `${p}.valueQuantity.value`,
      issues,
    );
  } else if (o['valueInteger'] === undefined && o['valueString'] === undefined) {
    issues.push({ path: p, message: 'observation has no value' });
  }
  // Symptom severity 0-10
  const coding = isObj(o['code']) && Array.isArray(o['code']['coding']) ? o['code']['coding'] : [];
  const isSymptom = coding.some(
    (c) => isObj(c) && String(c['code']).startsWith('symptom-severity'),
  );
  if (isSymptom) {
    const v = o['valueInteger'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10) {
      issues.push({
        path: `${p}.valueInteger`,
        message: 'symptom severity must be an integer 0–10',
      });
    }
  }
}

/** Validate one resource. Returns an empty list when valid. */
export function validateResource(r: unknown, path = 'resource'): Issue[] {
  const issues: Issue[] = [];
  if (!isObj(r)) return [{ path, message: 'must be an object' }];
  const type = r['resourceType'];
  if (typeof type !== 'string' || !TYPES.has(type)) {
    return [
      { path: `${path}.resourceType`, message: `unsupported resourceType "${String(type)}"` },
    ];
  }
  if (
    typeof r['id'] !== 'string' ||
    r['id'].length === 0 ||
    !/^[A-Za-z0-9\-.]{1,64}$/.test(r['id'])
  ) {
    issues.push({ path: `${path}.id`, message: 'id must match [A-Za-z0-9-.]{1,64}' });
  }
  switch (type) {
    case 'Patient':
      if (r['birthDate'] !== undefined && !validDate(r['birthDate'])) {
        issues.push({ path: `${path}.birthDate`, message: 'invalid date' });
      }
      break;
    case 'Condition':
      checkRef(r['subject'], `${path}.subject`, issues);
      if (!isObj(r['code'])) issues.push({ path: `${path}.code`, message: 'required' });
      break;
    case 'Observation':
      checkRef(r['subject'], `${path}.subject`, issues);
      validateObservation(r, path, issues);
      break;
    case 'MedicationStatement':
      checkRef(r['subject'], `${path}.subject`, issues);
      if (!isObj(r['medicationCodeableConcept'])) {
        issues.push({ path: `${path}.medicationCodeableConcept`, message: 'required' });
      }
      break;
    case 'MedicationAdministration':
      checkRef(r['subject'], `${path}.subject`, issues);
      if (!['completed', 'not-done'].includes(String(r['status']))) {
        issues.push({ path: `${path}.status`, message: 'must be "completed" or "not-done"' });
      }
      if (!validDate(r['effectiveDateTime'])) {
        issues.push({
          path: `${path}.effectiveDateTime`,
          message: 'must be an ISO 8601 date/time',
        });
      }
      break;
  }
  return issues;
}

/** Validate a FHIR Bundle (import boundary). Also rejects duplicate type/id pairs. */
export function validateBundle(b: unknown): Issue[] {
  if (!isObj(b) || b['resourceType'] !== 'Bundle') {
    return [{ path: 'bundle', message: 'not a FHIR Bundle' }];
  }
  if (!Array.isArray(b['entry']))
    return [{ path: 'bundle.entry', message: 'entry array required' }];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  b['entry'].forEach((e, i) => {
    const res = isObj(e) ? e['resource'] : undefined;
    issues.push(...validateResource(res, `bundle.entry[${i}].resource`));
    if (isObj(res)) {
      const key = `${String(res['resourceType'])}/${String(res['id'])}`;
      if (seen.has(key)) issues.push({ path: `bundle.entry[${i}]`, message: `duplicate ${key}` });
      seen.add(key);
    }
  });
  return issues;
}

export function toBundle(resources: Resource[], timestamp: string): Bundle {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp,
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${resource.resourceType}-${resource.id}`,
      resource,
    })),
  };
}

/** Parse + validate JSON text; throws with a readable message on failure. */
export function parseBundle(json: string): Bundle {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('File is not valid JSON');
  }
  const issues = validateBundle(data);
  if (issues.length) {
    const head = issues
      .slice(0, 5)
      .map((i) => `${i.path}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Invalid FHIR Bundle (${issues.length} issue${issues.length > 1 ? 's' : ''}): ${head}`,
    );
  }
  return data as Bundle;
}

export function observationsOf(resources: Resource[]): Observation[] {
  return resources.filter((r): r is Observation => r.resourceType === 'Observation');
}
