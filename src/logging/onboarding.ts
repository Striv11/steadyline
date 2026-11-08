import type { Condition, Patient } from '../domain/fhir';
import { makeCondition, makePatient } from '../domain/builders';
import { CONDITIONS } from '../domain/codes';

export interface OnboardingInput {
  name: string;
  birthDate?: string;
  conditionKeys: string[];
}

/** Builds the Patient and one Condition per chosen key. Throws on invalid input. */
export function onboard(
  input: OnboardingInput,
  newId: () => string = () => crypto.randomUUID(),
  today = new Date().toISOString().slice(0, 10),
): { patient: Patient; conditions: Condition[] } {
  const name = input.name.trim();
  if (!name) throw new Error('Name is required');
  if (input.birthDate !== undefined && input.birthDate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate) || Number.isNaN(Date.parse(input.birthDate))) {
      throw new Error('Birth date must be YYYY-MM-DD');
    }
    if (input.birthDate > today) throw new Error('Birth date cannot be in the future');
  }
  const keys = [...new Set(input.conditionKeys)];
  for (const k of keys) if (!CONDITIONS[k]) throw new Error(`Unknown condition: ${k}`);
  const patient = makePatient(newId(), name, input.birthDate ? { birthDate: input.birthDate } : {});
  return { patient, conditions: keys.map((k) => makeCondition(newId(), patient.id, k)) };
}
