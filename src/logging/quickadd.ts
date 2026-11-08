import type { Observation, Resource } from '../domain/fhir';
import {
  makeAdministration,
  makeBloodPressure,
  makeLocalQuantity,
  makeSymptom,
  makeVital,
} from '../domain/builders';
import { LOCAL_CODES, VITALS, localConcept } from '../domain/codes';

export type ParseResult =
  { ok: true; resources: Resource[]; summary: string } | { ok: false; error: string };

export interface Ctx {
  patientId: string;
  /** ISO instant for the entry. */
  at: string;
  /** Deterministic in tests; defaults to a random UUID. */
  newId?: () => string;
}

const VITAL_ALIASES: Record<string, string> = {
  g: 'glucose',
  glu: 'glucose',
  glucose: 'glucose',
  w: 'weight',
  wt: 'weight',
  weight: 'weight',
  hr: 'heartRate',
  pulse: 'heartRate',
  spo2: 'spo2',
  o2: 'spo2',
  pf: 'peakFlow',
  temp: 'temperature',
};

const fail = (error: string): ParseResult => ({ ok: false, error });

function num(s: string | undefined): number | undefined {
  if (s === undefined || !/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/**
 * Parses one line of quick-add shorthand into FHIR resources.
 *
 *   g 112            glucose        bp 128/82       blood pressure
 *   w 71.5  hr 64    spo2 97  temp 37.2  pf 420
 *   sym headache 6 [body location]    0-10 severity
 *   med metformin [taken|missed]      defaults to taken
 *   sleep 7.5   mood 4 (1-5)
 *   food/act/trig/note <free text>
 */
export function parseQuickAdd(line: string, ctx: Ctx): ParseResult {
  const id = ctx.newId ?? (() => crypto.randomUUID());
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);
  if (!cmd) return fail('Type an entry, e.g. "bp 128/82" or "g 112".');
  const pid = ctx.patientId;

  if (cmd === 'bp') {
    const m = /^(\d{2,3})\/(\d{2,3})$/.exec(args[0] ?? '');
    if (!m) return fail('Blood pressure looks like "bp 128/82".');
    const sys = Number(m[1]);
    const dia = Number(m[2]);
    if (sys <= dia) return fail('Systolic must be higher than diastolic.');
    const s = VITALS['systolic']!;
    const d = VITALS['diastolic']!;
    if (sys < s.min || sys > s.max || dia < d.min || dia > d.max) {
      return fail('Blood pressure is outside the plausible range; check the numbers.');
    }
    return {
      ok: true,
      resources: [makeBloodPressure(id(), pid, sys, dia, ctx.at)],
      summary: `BP ${sys}/${dia} mmHg`,
    };
  }

  const vitalKey = VITAL_ALIASES[cmd];
  if (vitalKey) {
    const def = VITALS[vitalKey]!;
    const v = num(args[0]);
    if (v === undefined) return fail(`${def.label} needs a number, e.g. "${cmd} 100".`);
    if (v < def.min || v > def.max) {
      return fail(`${def.label} must be between ${def.min} and ${def.max} ${def.unit}.`);
    }
    return {
      ok: true,
      resources: [makeVital(id(), pid, vitalKey, v, ctx.at)],
      summary: `${def.label} ${v} ${def.unit}`,
    };
  }

  switch (cmd) {
    case 'sym': {
      // name = leading words up to the first number; rest after it is the body location
      const i = args.findIndex((a) => /^\d+$/.test(a));
      if (i < 1) return fail('Symptoms look like "sym headache 6 left temple".');
      const sev = Number(args[i]);
      if (sev > 10) return fail('Severity is 0 to 10.');
      const name = args.slice(0, i).join(' ');
      const site = args.slice(i + 1).join(' ') || undefined;
      return {
        ok: true,
        resources: [makeSymptom(id(), pid, name, sev, ctx.at, site)],
        summary: `${name} ${sev}/10${site ? ` (${site})` : ''}`,
      };
    }
    case 'med': {
      const last = args[args.length - 1]?.toLowerCase();
      const status = last === 'taken' || last === 'missed' ? last : undefined;
      const name = (status ? args.slice(0, -1) : args).join(' ');
      if (!name) return fail('Medication entries look like "med metformin missed".');
      const taken = status !== 'missed';
      return {
        ok: true,
        resources: [makeAdministration(id(), pid, name, taken, ctx.at)],
        summary: `${name} ${taken ? 'taken' : 'missed'}`,
      };
    }
    case 'sleep': {
      const v = num(args[0]);
      if (v === undefined || v > 24)
        return fail('Sleep is hours between 0 and 24, e.g. "sleep 7.5".');
      return {
        ok: true,
        resources: [makeLocalQuantity(id(), pid, 'sleepHours', 'Sleep duration', v, 'h', ctx.at)],
        summary: `Sleep ${v} h`,
      };
    }
    case 'mood': {
      const v = num(args[0]);
      if (v === undefined || !Number.isInteger(v) || v < 1 || v > 5) {
        return fail('Mood is a whole number from 1 (low) to 5 (good).');
      }
      return {
        ok: true,
        resources: [makeLocalQuantity(id(), pid, 'mood', 'Mood', v, 'score', ctx.at)],
        summary: `Mood ${v}/5`,
      };
    }
    case 'food':
    case 'act':
    case 'trig':
    case 'note': {
      const text = args.join(' ');
      if (!text) return fail(`Add some text after "${cmd}".`);
      const key = { food: 'food', act: 'activity', trig: 'trigger', note: 'note' }[cmd] as
        'food' | 'activity' | 'trigger' | 'note';
      const label = { food: 'Food', activity: 'Activity', trigger: 'Trigger', note: 'Note' }[key];
      const o: Observation = {
        resourceType: 'Observation',
        id: id(),
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'survey',
                display: 'Survey',
              },
            ],
          },
        ],
        code: localConcept(LOCAL_CODES[key], label),
        subject: { reference: `Patient/${pid}` },
        effectiveDateTime: ctx.at,
        valueString: text,
      };
      return { ok: true, resources: [o], summary: `${label}: ${text}` };
    }
    default:
      return fail(
        `Unknown entry "${cmd}". Try g, bp, w, hr, sym, med, sleep, mood, food, act, trig, note.`,
      );
  }
}
