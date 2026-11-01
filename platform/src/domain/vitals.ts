/**
 * Vital signs recorded at visits, with LOINC codes and alert thresholds.
 * Thresholds flag readings for clinical review; they are not diagnoses.
 * Sources: ACC/AHA 2017 BP guideline (hypertensive crisis ≥180/120),
 * ADA Standards of Care (level 2 hypoglycemia <54 mg/dL), common early-warning
 * practice for SpO2, heart rate, temperature and respiratory rate.
 */
export const VITALS = {
  bp: { loinc: '85354-9', unit: 'mmHg', label: 'Blood pressure' },
  glucose: { loinc: '2339-0', unit: 'mg/dL', label: 'Blood glucose' },
  spo2: { loinc: '59408-5', unit: '%', label: 'Oxygen saturation' },
  hr: { loinc: '8867-4', unit: '/min', label: 'Heart rate' },
  temp: { loinc: '8310-5', unit: '°C', label: 'Body temperature' },
  rr: { loinc: '9279-1', unit: '/min', label: 'Respiratory rate' },
  weight: { loinc: '29463-7', unit: 'kg', label: 'Body weight' },
} as const;

export type VitalCode = keyof typeof VITALS;

export interface Reading {
  code: VitalCode;
  value: number;
  value2?: number | null; // diastolic
}

export interface Flag {
  severity: 'critical' | 'warning';
  message: string;
}

/** Plausible physical ranges: anything outside is a typo, rejected at input. */
const PLAUSIBLE: Record<VitalCode, [number, number]> = {
  bp: [50, 300],
  glucose: [10, 800],
  spo2: [50, 100],
  hr: [20, 250],
  temp: [30, 44],
  rr: [4, 70],
  weight: [1, 400],
};

export function validateReading(r: Reading): string | null {
  const [lo, hi] = PLAUSIBLE[r.code];
  if (!Number.isFinite(r.value) || r.value < lo || r.value > hi)
    return `${VITALS[r.code].label} ${r.value} is outside ${lo}–${hi}`;
  if (r.code === 'bp') {
    if (r.value2 == null || !Number.isFinite(r.value2) || r.value2 < 30 || r.value2 > 200)
      return 'Diastolic pressure is required (30–200)';
    if (r.value2 >= r.value) return 'Diastolic must be lower than systolic';
  }
  return null;
}

export function assess(r: Reading): Flag | null {
  const v = r.value;
  switch (r.code) {
    case 'bp': {
      const d = r.value2 ?? 0;
      if (v >= 180 || d >= 120)
        return {
          severity: 'critical',
          message: `BP ${v}/${d}: hypertensive crisis range; needs urgent clinical review`,
        };
      if (v < 90 || d < 60)
        return { severity: 'warning', message: `BP ${v}/${d}: low blood pressure` };
      if (v >= 160 || d >= 100)
        return { severity: 'warning', message: `BP ${v}/${d}: markedly elevated` };
      return null;
    }
    case 'glucose':
      if (v < 54)
        return {
          severity: 'critical',
          message: `Glucose ${v} mg/dL: severe hypoglycemia (level 2)`,
        };
      if (v > 400)
        return { severity: 'critical', message: `Glucose ${v} mg/dL: severe hyperglycemia` };
      if (v < 70)
        return { severity: 'warning', message: `Glucose ${v} mg/dL: hypoglycemia (level 1)` };
      if (v > 250) return { severity: 'warning', message: `Glucose ${v} mg/dL: high` };
      return null;
    case 'spo2':
      if (v < 90) return { severity: 'critical', message: `SpO₂ ${v}%: low oxygen` };
      if (v < 94) return { severity: 'warning', message: `SpO₂ ${v}%: below normal` };
      return null;
    case 'hr':
      if (v > 130 || v < 40)
        return { severity: 'critical', message: `Heart rate ${v}/min: out of safe range` };
      if (v > 110 || v < 50)
        return { severity: 'warning', message: `Heart rate ${v}/min: abnormal` };
      return null;
    case 'temp':
      if (v >= 39.5 || v < 35)
        return { severity: 'critical', message: `Temperature ${v} °C: needs review` };
      if (v >= 38) return { severity: 'warning', message: `Temperature ${v} °C: fever` };
      return null;
    case 'rr':
      if (v > 30 || v < 8)
        return { severity: 'critical', message: `Respiratory rate ${v}/min: out of safe range` };
      if (v > 24)
        return { severity: 'warning', message: `Respiratory rate ${v}/min: fast breathing` };
      return null;
    case 'weight':
      return null;
  }
}
