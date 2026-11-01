import type {
  Condition,
  MedicationAdministration,
  MedicationStatement,
  Observation,
  Patient,
} from './fhir';
import {
  CONDITIONS,
  LOCAL_CODES,
  LOINC_BP_PANEL,
  SYSTEM_LOCAL,
  SYSTEM_LOINC,
  SYSTEM_OBS_CATEGORY,
  SYSTEM_SNOMED,
  SYSTEM_UCUM,
  SYNTHETIC_TAG,
  VITALS,
  loincConcept,
  localConcept,
} from './codes';

const vitalCategory = [
  { coding: [{ system: SYSTEM_OBS_CATEGORY, code: 'vital-signs', display: 'Vital Signs' }] },
];
const surveyCategory = [
  { coding: [{ system: SYSTEM_OBS_CATEGORY, code: 'survey', display: 'Survey' }] },
];

export function patientRef(p: Pick<Patient, 'id'>) {
  return { reference: `Patient/${p.id}` };
}

export function makePatient(
  id: string,
  name: string,
  opts: { synthetic?: boolean; birthDate?: string } = {},
): Patient {
  const p: Patient = { resourceType: 'Patient', id, name: [{ text: name }] };
  if (opts.birthDate) p.birthDate = opts.birthDate;
  if (opts.synthetic) p.meta = { tag: [SYNTHETIC_TAG] };
  return p;
}

export function makeCondition(
  id: string,
  patientId: string,
  key: string,
  onset?: string,
): Condition {
  const def = CONDITIONS[key];
  if (!def) throw new Error(`Unknown condition key: ${key}`);
  const c: Condition = {
    resourceType: 'Condition',
    id,
    subject: { reference: `Patient/${patientId}` },
    code: {
      coding: [{ system: SYSTEM_SNOMED, code: def.snomed, display: def.label }],
      text: def.label,
    },
    clinicalStatus: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' },
      ],
    },
  };
  if (onset) c.onsetDateTime = onset;
  return c;
}

export function makeVital(
  id: string,
  patientId: string,
  key: string,
  value: number,
  at: string,
): Observation {
  const def = VITALS[key];
  if (!def) throw new Error(`Unknown vital key: ${key}`);
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    category: vitalCategory,
    code: loincConcept(def),
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: at,
    valueQuantity: { value, unit: def.unit, system: SYSTEM_UCUM, code: def.ucum },
  };
}

/** Blood pressure uses the FHIR vital-signs BP panel with systolic/diastolic components. */
export function makeBloodPressure(
  id: string,
  patientId: string,
  sys: number,
  dia: number,
  at: string,
): Observation {
  const s = VITALS['systolic']!;
  const d = VITALS['diastolic']!;
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    category: vitalCategory,
    code: {
      coding: [{ system: SYSTEM_LOINC, code: LOINC_BP_PANEL, display: 'Blood pressure panel' }],
    },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: at,
    component: [
      {
        code: loincConcept(s),
        valueQuantity: { value: sys, unit: s.unit, system: SYSTEM_UCUM, code: s.ucum },
      },
      {
        code: loincConcept(d),
        valueQuantity: { value: dia, unit: d.unit, system: SYSTEM_UCUM, code: d.ucum },
      },
    ],
  };
}

/** Symptom severity 0–10 with an optional body location. */
export function makeSymptom(
  id: string,
  patientId: string,
  name: string,
  severity: number,
  at: string,
  bodySite?: string,
): Observation {
  const o: Observation = {
    resourceType: 'Observation',
    id,
    status: 'final',
    category: surveyCategory,
    code: {
      coding: [{ system: SYSTEM_LOCAL, code: `${LOCAL_CODES.symptom}:${name}`, display: name }],
      text: name,
    },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: at,
    valueInteger: severity,
  };
  if (bodySite) o.bodySite = { text: bodySite };
  return o;
}

export function makeLocalQuantity(
  id: string,
  patientId: string,
  code: keyof typeof LOCAL_CODES,
  label: string,
  value: number,
  unit: string,
  at: string,
): Observation {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    category: surveyCategory,
    code: localConcept(LOCAL_CODES[code], label),
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: at,
    valueQuantity: { value, unit },
  };
}

export function makeMedication(
  id: string,
  patientId: string,
  name: string,
  timesOfDay: string[],
  start: string,
): MedicationStatement {
  return {
    resourceType: 'MedicationStatement',
    id,
    status: 'active',
    medicationCodeableConcept: { text: name },
    subject: { reference: `Patient/${patientId}` },
    effectivePeriod: { start },
    dosage: [{ text: 'As prescribed', timing: { repeat: { timeOfDay: timesOfDay } } }],
  };
}

export function makeAdministration(
  id: string,
  patientId: string,
  medName: string,
  taken: boolean,
  at: string,
): MedicationAdministration {
  return {
    resourceType: 'MedicationAdministration',
    id,
    status: taken ? 'completed' : 'not-done',
    medicationCodeableConcept: { text: medName },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: at,
  };
}
