import { describe, expect, it } from 'vitest';
import { validateResource } from '../domain/validate';
import type { Observation } from '../domain/fhir';
import { onboard } from './onboarding';
import { parseQuickAdd } from './quickadd';

let n = 0;
const ctx = { patientId: 'p1', at: '2026-11-08T08:00:00Z', newId: () => `id${++n}` };

describe('parseQuickAdd', () => {
  it('parses every supported entry into valid resources', () => {
    for (const line of [
      'g 112',
      'bp 128/82',
      'w 71.5',
      'hr 64',
      'spo2 97',
      'temp 37.2',
      'pf 420',
      'sym headache 6',
      'sym joint pain 3 left knee',
      'med metformin',
      'med metformin missed',
      'sleep 7.5',
      'mood 4',
      'food rice and dal',
      'act walk 30 min',
      'trig stress',
      'note slept badly',
    ]) {
      const r = parseQuickAdd(line, ctx);
      expect(r.ok, line).toBe(true);
      if (r.ok) for (const res of r.resources) expect(validateResource(res), line).toEqual([]);
    }
  });

  it('builds the expected values', () => {
    const r = parseQuickAdd('sym joint pain 3 left knee', ctx);
    if (!r.ok) throw new Error(r.error);
    const o = r.resources[0] as Observation;
    expect(o.valueInteger).toBe(3);
    expect(o.bodySite?.text).toBe('left knee');
    expect(o.code.text).toBe('joint pain');
    const m = parseQuickAdd('MED Metformin 500 missed', ctx);
    if (!m.ok) throw new Error(m.error);
    expect(m.resources[0]).toMatchObject({ status: 'not-done' });
    expect(m.summary).toBe('Metformin 500 missed');
  });

  it.each([
    '',
    'bp 80/120',
    'bp 128',
    'bp 500/90',
    'g',
    'g abc',
    'g 5',
    'g 9999',
    'sym headache 11',
    'sym 5',
    'sym headache',
    'med',
    'sleep 30',
    'mood 0',
    'mood 3.5',
    'note',
    'zzz 1',
    'w -3',
  ])('rejects %j with a message', (line) => {
    const r = parseQuickAdd(line, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
  });
});

describe('onboard', () => {
  it('creates a patient and deduplicated conditions', () => {
    let i = 0;
    const r = onboard(
      { name: ' Asha ', birthDate: '1980-02-03', conditionKeys: ['t2d', 'htn', 't2d'] },
      () => `x${++i}`,
    );
    expect(r.patient.name?.[0]?.text).toBe('Asha');
    expect(r.conditions).toHaveLength(2);
    for (const res of [r.patient, ...r.conditions]) expect(validateResource(res)).toEqual([]);
    expect(r.conditions[0]!.subject.reference).toBe(`Patient/${r.patient.id}`);
  });

  it('rejects bad input', () => {
    expect(() => onboard({ name: ' ', conditionKeys: [] })).toThrow(/Name/);
    expect(() => onboard({ name: 'A', conditionKeys: ['nope'] })).toThrow(/Unknown/);
    expect(() => onboard({ name: 'A', birthDate: '03/02/1980', conditionKeys: [] })).toThrow(
      /YYYY/,
    );
    expect(() =>
      onboard({ name: 'A', birthDate: '2999-01-01', conditionKeys: [] }, undefined, '2026-11-08'),
    ).toThrow(/future/);
  });
});
