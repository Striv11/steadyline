import type { Condition } from '../domain/fhir';
import { CONDITIONS } from '../domain/codes';

/** A one-tap quick-add suggestion. `line` is shorthand;. */
export interface Template {
  label: string;
  /** Text placed in the quick-add box. A trailing space means "type the value next". */
  line: string;
  /** A complete example that parses, used in tests and as help text. */
  example: string;
}

const GENERAL: Template[] = [
  { label: 'Note', line: 'note ', example: 'note slept badly' },
  { label: 'Sleep', line: 'sleep ', example: 'sleep 7.5' },
  { label: 'Mood', line: 'mood ', example: 'mood 4' },
];

const BP: Template = { label: 'Blood pressure', line: 'bp ', example: 'bp 128/82' };
const GLUCOSE: Template = { label: 'Glucose', line: 'g ', example: 'g 112' };
const WEIGHT: Template = { label: 'Weight', line: 'w ', example: 'w 71.5' };
const HR: Template = { label: 'Heart rate', line: 'hr ', example: 'hr 64' };
const SPO2: Template = { label: 'SpO2', line: 'spo2 ', example: 'spo2 97' };
const PEAK: Template = { label: 'Peak flow', line: 'pf ', example: 'pf 420' };
const MED: Template = { label: 'Medication', line: 'med ', example: 'med metformin' };
const FOOD: Template = { label: 'Meal', line: 'food ', example: 'food rice and dal' };
const ACT: Template = { label: 'Activity', line: 'act ', example: 'act walk 30 min' };
const TRIG: Template = { label: 'Trigger', line: 'trig ', example: 'trig stress' };
const sym = (label: string, name: string, extra = ''): Template => ({
  label,
  line: `sym ${name} `,
  example: `sym ${name} 4${extra}`,
});

const BY_CONDITION: Record<string, Template[]> = {
  t1d: [GLUCOSE, MED, FOOD, ACT, WEIGHT],
  t2d: [GLUCOSE, MED, FOOD, ACT, WEIGHT],
  htn: [BP, HR, MED, WEIGHT, ACT],
  asthma: [PEAK, SPO2, sym('Wheeze', 'wheeze'), MED, TRIG],
  copd: [SPO2, PEAK, sym('Breathlessness', 'breathlessness'), MED, TRIG],
  crohns: [sym('Abdominal pain', 'abdominal pain'), sym('Fatigue', 'fatigue'), FOOD, MED, WEIGHT],
  uc: [sym('Urgency', 'urgency'), sym('Abdominal pain', 'abdominal pain'), FOOD, MED, WEIGHT],
  migraine: [sym('Headache', 'headache', ' left temple'), TRIG, MED, FOOD],
  ra: [sym('Joint pain', 'joint pain', ' left knee'), sym('Morning stiffness', 'stiffness'), MED],
  lupus: [sym('Joint pain', 'joint pain', ' left knee'), sym('Fatigue', 'fatigue'), TRIG, MED],
  ckd: [BP, WEIGHT, MED, FOOD],
  hf: [WEIGHT, BP, HR, SPO2, sym('Swelling', 'swelling', ' ankles'), MED],
};

/** Condition keys recorded on Condition resources, via their SNOMED code. */
export function conditionKeys(conditions: Condition[]): string[] {
  const bySnomed = new Map(Object.values(CONDITIONS).map((d) => [d.snomed, d.key]));
  const keys: string[] = [];
  for (const c of conditions) {
    for (const coding of c.code?.coding ?? []) {
      const k = bySnomed.get(coding.code ?? '');
      if (k && !keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

/** Suggestions for the given condition keys: deduplicated by line, then the general ones. */
export function templatesFor(keys: string[]): Template[] {
  const seen = new Set<string>();
  const out: Template[] = [];
  for (const t of [...keys.flatMap((k) => BY_CONDITION[k] ?? []), ...GENERAL]) {
    if (seen.has(t.line)) continue;
    seen.add(t.line);
    out.push(t);
  }
  return out;
}

export const TEMPLATE_CONDITION_KEYS = Object.keys(BY_CONDITION);
