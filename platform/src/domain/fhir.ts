/**
 * Export of visit readings as a FHIR R4 Bundle that the local-first Steadyline
 * dashboard can import. Resource shapes match the dashboard's `src/domain`.
 */
import { VITALS, type VitalCode } from './vitals.js';

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';

const UCUM_CODE: Record<VitalCode, string> = {
  bp: 'mm[Hg]',
  glucose: 'mg/dL',
  spo2: '%',
  hr: '/min',
  temp: 'Cel',
  rr: '/min',
  weight: 'kg',
};

export interface ObsRow {
  id: string;
  code: string;
  value: number;
  value2: number | null;
  recorded_at: string;
}

export interface ExportPatient {
  id: string;
  name: string;
  date_of_birth: string | null;
}

/** FHIR ids allow [A-Za-z0-9-.]; platform ids use underscores. */
const fid = (s: string) => s.replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, 64);

const category = [{ coding: [{ system: CATEGORY, code: 'vital-signs', display: 'Vital Signs' }] }];

function concept(loinc: string, display: string) {
  return { coding: [{ system: LOINC, code: loinc, display }] };
}

function quantity(code: VitalCode, value: number) {
  return { value, unit: VITALS[code].unit, system: UCUM, code: UCUM_CODE[code] };
}

export function observationResource(patientId: string, o: ObsRow) {
  const code = o.code as VitalCode;
  if (!(code in VITALS)) return null;
  const base = {
    resourceType: 'Observation' as const,
    id: fid(o.id),
    status: 'final' as const,
    category,
    subject: { reference: `Patient/${fid(patientId)}` },
    effectiveDateTime: o.recorded_at,
    note: [{ text: 'Recorded by a Steadyline Care professional during a visit.' }],
  };
  if (code === 'bp') {
    if (o.value2 == null) return null;
    return {
      ...base,
      code: concept(VITALS.bp.loinc, 'Blood pressure panel'),
      component: [
        {
          code: concept('8480-6', 'Systolic blood pressure'),
          valueQuantity: { value: o.value, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' },
        },
        {
          code: concept('8462-4', 'Diastolic blood pressure'),
          valueQuantity: { value: o.value2, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' },
        },
      ],
    };
  }
  return {
    ...base,
    code: concept(VITALS[code].loinc, VITALS[code].label),
    valueQuantity: quantity(code, o.value),
  };
}

export function buildExportBundle(patient: ExportPatient, rows: ObsRow[], timestamp: string) {
  const pid = fid(patient.id);
  const pat: Record<string, unknown> = {
    resourceType: 'Patient',
    id: pid,
    name: [{ text: patient.name }],
  };
  if (patient.date_of_birth && /^\d{4}-\d{2}-\d{2}$/.test(patient.date_of_birth))
    pat['birthDate'] = patient.date_of_birth;
  const resources = [pat, ...rows.map((r) => observationResource(patient.id, r))].filter(
    (r): r is Record<string, unknown> => r !== null,
  );
  return {
    resourceType: 'Bundle' as const,
    type: 'collection' as const,
    timestamp,
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${String(resource['resourceType'])}-${String(resource['id'])}`,
      resource,
    })),
  };
}
