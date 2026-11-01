import type { CodeableConcept, Coding } from './fhir';

export const SYSTEM_LOINC = 'http://loinc.org';
export const SYSTEM_SNOMED = 'http://snomed.info/sct';
export const SYSTEM_UCUM = 'http://unitsofmeasure.org';
export const SYSTEM_LOCAL = 'https://steadyline.app/fhir/CodeSystem/local';
export const SYSTEM_OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
export const SYNTHETIC_TAG: Coding = {
  system: SYSTEM_LOCAL,
  code: 'synthetic',
  display: 'Synthetic demo data',
};

export interface VitalDef {
  key: string;
  label: string;
  loinc: string;
  unit: string;
  ucum: string;
  /** Plausible physiological range, used for entry validation (not diagnosis). */
  min: number;
  max: number;
}

/** Vitals. LOINC codes follow the LOINC "Vital signs" value set where one exists. */
export const VITALS: Record<string, VitalDef> = {
  glucose: {
    key: 'glucose',
    label: 'Glucose',
    loinc: '2339-0',
    unit: 'mg/dL',
    ucum: 'mg/dL',
    min: 20,
    max: 700,
  },
  systolic: {
    key: 'systolic',
    label: 'Systolic BP',
    loinc: '8480-6',
    unit: 'mmHg',
    ucum: 'mm[Hg]',
    min: 40,
    max: 300,
  },
  diastolic: {
    key: 'diastolic',
    label: 'Diastolic BP',
    loinc: '8462-4',
    unit: 'mmHg',
    ucum: 'mm[Hg]',
    min: 20,
    max: 200,
  },
  weight: {
    key: 'weight',
    label: 'Weight',
    loinc: '29463-7',
    unit: 'kg',
    ucum: 'kg',
    min: 2,
    max: 500,
  },
  heartRate: {
    key: 'heartRate',
    label: 'Heart rate',
    loinc: '8867-4',
    unit: 'bpm',
    ucum: '/min',
    min: 20,
    max: 300,
  },
  spo2: { key: 'spo2', label: 'SpO₂', loinc: '59408-5', unit: '%', ucum: '%', min: 50, max: 100 },
  peakFlow: {
    key: 'peakFlow',
    label: 'Peak flow',
    loinc: '33452-4',
    unit: 'L/min',
    ucum: 'L/min',
    min: 30,
    max: 900,
  },
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    loinc: '8310-5',
    unit: '°C',
    ucum: 'Cel',
    min: 30,
    max: 45,
  },
};

export const LOINC_BP_PANEL = '85354-9';

export const LOINC_TO_VITAL: Record<string, VitalDef> = Object.fromEntries(
  Object.values(VITALS).map((v) => [v.loinc, v]),
);

/** Local codes for observations with no suitable LOINC code. */
export const LOCAL_CODES = {
  symptom: 'symptom-severity',
  mood: 'mood',
  sleepHours: 'sleep-duration',
  food: 'food',
  activity: 'activity',
  trigger: 'trigger',
  note: 'note',
} as const;

export interface ConditionDef {
  key: string;
  label: string;
  snomed: string;
}

/** SNOMED CT concept ids for the supported conditions. */
export const CONDITIONS: Record<string, ConditionDef> = {
  t1d: { key: 't1d', label: 'Type 1 diabetes', snomed: '46635009' },
  t2d: { key: 't2d', label: 'Type 2 diabetes', snomed: '44054006' },
  htn: { key: 'htn', label: 'Hypertension', snomed: '38341003' },
  asthma: { key: 'asthma', label: 'Asthma', snomed: '195967001' },
  copd: { key: 'copd', label: 'COPD', snomed: '13645005' },
  crohns: { key: 'crohns', label: "Crohn's disease", snomed: '34000006' },
  uc: { key: 'uc', label: 'Ulcerative colitis', snomed: '64766004' },
  migraine: { key: 'migraine', label: 'Migraine', snomed: '37796009' },
  ra: { key: 'ra', label: 'Rheumatoid arthritis', snomed: '69896004' },
  lupus: { key: 'lupus', label: 'Lupus (SLE)', snomed: '55464009' },
  ckd: { key: 'ckd', label: 'Chronic kidney disease', snomed: '709044004' },
  hf: { key: 'hf', label: 'Heart failure', snomed: '84114007' },
};

export function loincConcept(def: VitalDef): CodeableConcept {
  return {
    coding: [{ system: SYSTEM_LOINC, code: def.loinc, display: def.label }],
    text: def.label,
  };
}

export function localConcept(code: string, text: string): CodeableConcept {
  return { coding: [{ system: SYSTEM_LOCAL, code, display: text }], text };
}
