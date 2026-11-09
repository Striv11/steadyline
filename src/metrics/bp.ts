/**
 * Blood pressure metrics.
 *
 * Source: Whelton PK, et al. 2017 ACC/AHA Guideline for the Prevention, Detection, Evaluation,
 * and Management of High Blood Pressure in Adults. Hypertension 2018;71:e13-e115. Table 6.
 *
 *   Normal    SBP < 120 and DBP < 80
 *   Elevated  SBP 120-129 and DBP < 80
 *   Stage 1   SBP 130-139 or DBP 80-89
 *   Stage 2   SBP >= 140 or DBP >= 90
 *   Crisis    SBP > 180 and/or DBP > 120 (the guideline's "hypertensive crisis" threshold)
 *
 * When SBP and DBP fall in different categories, the higher category applies. Readings are
 * compared as reported (integers from home cuffs). A category describes one reading or an
 * average; it is not a diagnosis, which needs repeated measurements on separate occasions.
 */
import type { Observation } from '../domain/fhir';
import { LOINC_BP_PANEL, VITALS } from '../domain/codes';

export type BpCategory = 'normal' | 'elevated' | 'stage1' | 'stage2' | 'crisis';

export const BP_LABELS: Record<BpCategory, string> = {
  normal: 'Normal',
  elevated: 'Elevated',
  stage1: 'Stage 1 hypertension range',
  stage2: 'Stage 2 hypertension range',
  crisis: 'Hypertensive crisis range',
};

const ORDER: BpCategory[] = ['normal', 'elevated', 'stage1', 'stage2', 'crisis'];

export function classifyBp(sys: number, dia: number): BpCategory {
  if (sys > 180 || dia > 120) return 'crisis';
  if (sys >= 140 || dia >= 90) return 'stage2';
  if (sys >= 130 || dia >= 80) return 'stage1';
  if (sys >= 120) return 'elevated';
  return 'normal';
}

export interface BpReading {
  /** Epoch milliseconds. */
  t: number;
  sys: number;
  dia: number;
}

/** Extract blood-pressure panel readings from Observations, sorted by time. Others are ignored. */
export function bpReadings(observations: Observation[]): BpReading[] {
  const sysCode = VITALS['systolic']!.loinc;
  const diaCode = VITALS['diastolic']!.loinc;
  const out: BpReading[] = [];
  for (const o of observations) {
    if (!o.code.coding?.some((c) => c.code === LOINC_BP_PANEL)) continue;
    const val = (loinc: string) =>
      o.component?.find((c) => c.code.coding?.some((x) => x.code === loinc))?.valueQuantity?.value;
    const sys = val(sysCode);
    const dia = val(diaCode);
    const t = Date.parse(o.effectiveDateTime);
    if (sys === undefined || dia === undefined || Number.isNaN(t)) continue;
    out.push({ t, sys, dia });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface BpSummary {
  n: number;
  meanSys: number;
  meanDia: number;
  /** Category of the rounded average. */
  category: BpCategory;
  /** Percent of individual readings per category (sums to 100). */
  share: Record<BpCategory, number>;
  /** Highest category seen in any single reading. */
  worst: BpCategory;
}

export function summarizeBp(readings: BpReading[]): BpSummary | null {
  if (readings.length === 0) return null;
  const n = readings.length;
  const meanSys = readings.reduce((a, r) => a + r.sys, 0) / n;
  const meanDia = readings.reduce((a, r) => a + r.dia, 0) / n;
  const counts: Record<BpCategory, number> = {
    normal: 0,
    elevated: 0,
    stage1: 0,
    stage2: 0,
    crisis: 0,
  };
  let worst = 0;
  for (const r of readings) {
    const c = classifyBp(r.sys, r.dia);
    counts[c]++;
    worst = Math.max(worst, ORDER.indexOf(c));
  }
  const share = Object.fromEntries(ORDER.map((c) => [c, (counts[c] / n) * 100])) as Record<
    BpCategory,
    number
  >;
  return {
    n,
    meanSys,
    meanDia,
    category: classifyBp(Math.round(meanSys), Math.round(meanDia)),
    share,
    worst: ORDER[worst]!,
  };
}

export interface BpDay {
  day: string;
  n: number;
  meanSys: number;
  meanDia: number;
  category: BpCategory;
}

/** Daily averages (UTC days) for charts and the accessible table. */
export function dailyBp(readings: BpReading[]): BpDay[] {
  const byDay = new Map<string, BpReading[]>();
  for (const r of readings) {
    const k = new Date(r.t).toISOString().slice(0, 10);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r);
  }
  return [...byDay]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, rs]) => {
      const meanSys = rs.reduce((a, r) => a + r.sys, 0) / rs.length;
      const meanDia = rs.reduce((a, r) => a + r.dia, 0) / rs.length;
      return {
        day,
        n: rs.length,
        meanSys,
        meanDia,
        category: classifyBp(Math.round(meanSys), Math.round(meanDia)),
      };
    });
}
