import type { Resource } from '../domain/fhir';
import {
  makeAdministration,
  makeBloodPressure,
  makeCondition,
  makeLocalQuantity,
  makeMedication,
  makePatient,
  makeSymptom,
  makeVital,
} from '../domain/builders';
import { Rng } from './rng';

/** One CGM sample. `t` is epoch milliseconds, `mgdl` is glucose in mg/dL. */
export interface GlucoseSample {
  t: number;
  mgdl: number;
}

export interface SyntheticPatient {
  seed: number;
  patientId: string;
  /** Always true: the generator only produces simulated people. */
  synthetic: true;
  resources: Resource[];
  cgm: GlucoseSample[];
}

export interface GenerateOptions {
  seed?: number;
  days?: number;
  /** ISO date (UTC midnight) of the first simulated day. */
  start?: string;
  /** CGM sampling interval in minutes (5 = Dexcom-style, 15 = Libre-style, 1 = stress test). */
  cgmIntervalMin?: number;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * Deterministic synthetic patient: type 2 diabetes + hypertension + migraine.
 * Same options → byte-identical output. Nothing here is derived from real people.
 */
export function generateSyntheticPatient(opts: GenerateOptions = {}): SyntheticPatient {
  const seed = opts.seed ?? 42;
  const days = opts.days ?? 90;
  const step = opts.cgmIntervalMin ?? 5;
  const t0 = Date.parse(`${opts.start ?? '2026-01-01'}T00:00:00Z`);
  const rng = new Rng(seed);
  const pid = 'demo-patient';
  const resources: Resource[] = [
    makePatient(pid, 'Alex Demo (synthetic)', { synthetic: true, birthDate: '1975-06-15' }),
    makeCondition('c-t2d', pid, 't2d', '2019-03-01'),
    makeCondition('c-htn', pid, 'htn', '2020-09-01'),
    makeCondition('c-migraine', pid, 'migraine', '2012-01-01'),
    makeMedication('m-metformin', pid, 'Metformin (demo)', ['08:00', '20:00'], '2019-03-01'),
    makeMedication('m-lisinopril', pid, 'Lisinopril (demo)', ['08:00'], '2020-09-01'),
  ];
  const cgm: GlucoseSample[] = [];
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const iso = (ms: number) => new Date(ms).toISOString();

  let noise = 0;
  const perDay = (24 * 60) / step;
  for (let d = 0; d < days; d++) {
    const day0 = t0 + d * DAY;
    const sleepH = Math.min(9.5, Math.max(4, rng.normal(7, 1.1)));
    const stress = Math.max(0, rng.normal(0.3, 0.25));
    // Short sleep nudges next-day glucose up (a deliberate, discoverable association).
    const sleepEffect = (7 - sleepH) * 6;
    const meals = [
      { h: 7.75 + rng.normal(0, 0.3), amp: rng.normal(45, 12) },
      { h: 12.5 + rng.normal(0, 0.4), amp: rng.normal(55, 15) },
      { h: 19 + rng.normal(0, 0.5), amp: rng.normal(60, 18) },
    ];
    for (let i = 0; i < perDay; i++) {
      const hour = (i * step) / 60;
      let g = 118 + sleepEffect + 8 * Math.sin(((hour - 4) / 24) * 2 * Math.PI);
      for (const m of meals) {
        const dt = hour - m.h;
        if (dt > 0) g += Math.max(0, m.amp) * (dt / 1.0) * Math.exp(1 - dt / 1.0) * 0.9;
      }
      noise = 0.85 * noise + rng.normal(0, 3.2);
      const v = Math.round(Math.min(400, Math.max(40, g + noise + stress * 10)));
      cgm.push({ t: day0 + i * step * MIN, mgdl: v });
    }

    const at = (h: number) => iso(day0 + Math.round(h * 60) * MIN);
    resources.push(
      makeLocalQuantity(
        id('sleep'),
        pid,
        'sleepHours',
        'Sleep duration',
        Math.round(sleepH * 10) / 10,
        'h',
        at(7),
      ),
    );
    resources.push(
      makeLocalQuantity(
        id('mood'),
        pid,
        'mood',
        'Mood (1-5)',
        Math.min(5, Math.max(1, Math.round(rng.normal(3.6 - stress, 0.9)))),
        'score',
        at(21),
      ),
    );

    // Blood pressure: morning + evening, slowly drifting, higher after short sleep.
    for (const h of [8.25, 20.5]) {
      const sys = Math.round(rng.normal(131 + (7 - sleepH) * 1.5 + 3 * stress, 7));
      const dia = Math.round(rng.normal(82 + (7 - sleepH), 5));
      resources.push(makeBloodPressure(id('bp'), pid, sys, Math.min(dia, sys - 20), at(h)));
    }
    if (rng.chance(0.5))
      resources.push(makeVital(id('hr'), pid, 'heartRate', Math.round(rng.normal(72, 6)), at(8.3)));
    if (d % 7 === 0)
      resources.push(
        makeVital(id('wt'), pid, 'weight', Math.round(rng.normal(88, 0.5) * 10) / 10, at(7.5)),
      );

    // Medication adherence ~88%, worse on high-stress days.
    for (const [med, times] of [
      ['Metformin (demo)', [8, 20]],
      ['Lisinopril (demo)', [8]],
    ] as const) {
      for (const h of times) {
        const taken = !rng.chance(0.08 + stress * 0.12);
        resources.push(makeAdministration(id('adm'), pid, med, taken, at(h + 0.1)));
      }
    }

    // Migraine: more likely after short sleep or high stress.
    const pMigraine = 0.04 + Math.max(0, 6.5 - sleepH) * 0.08 + stress * 0.1;
    if (rng.chance(pMigraine)) {
      const sev = Math.min(10, Math.max(2, Math.round(rng.normal(6, 1.8))));
      resources.push(makeSymptom(id('sym'), pid, 'Migraine', sev, at(rng.int(9, 17)), 'Head'));
    }
    if (rng.chance(0.15)) {
      resources.push(makeSymptom(id('sym'), pid, 'Fatigue', rng.int(2, 6), at(15), 'Whole body'));
    }
  }
  return { seed, patientId: pid, synthetic: true, resources, cgm };
}
