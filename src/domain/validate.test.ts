import { describe, expect, it } from 'vitest';
import { makeBloodPressure, makeCondition, makePatient, makeSymptom, makeVital } from './builders';
import { parseBundle, toBundle, validateBundle, validateResource } from './validate';

const at = '2026-03-01T08:00:00Z';

describe('validateResource', () => {
  it('accepts well-formed resources', () => {
    expect(validateResource(makePatient('p1', 'Test'))).toEqual([]);
    expect(validateResource(makeCondition('c1', 'p1', 'asthma'))).toEqual([]);
    expect(validateResource(makeVital('o1', 'p1', 'glucose', 110, at))).toEqual([]);
    expect(validateResource(makeBloodPressure('o2', 'p1', 128, 82, at))).toEqual([]);
    expect(validateResource(makeSymptom('o3', 'p1', 'Headache', 4, at, 'Head'))).toEqual([]);
  });

  it('rejects implausible vitals', () => {
    const issues = validateResource(makeVital('o1', 'p1', 'spo2', 140, at));
    expect(issues[0]?.message).toMatch(/outside the plausible range/);
  });

  it('rejects BP where systolic <= diastolic', () => {
    expect(validateResource(makeBloodPressure('o', 'p1', 80, 90, at)).length).toBe(1);
  });

  it('enforces symptom severity 0-10 integer', () => {
    expect(validateResource(makeSymptom('s', 'p1', 'Pain', 11, at))).toHaveLength(1);
    expect(validateResource(makeSymptom('s', 'p1', 'Pain', 2.5, at))).toHaveLength(1);
    expect(validateResource(makeSymptom('s', 'p1', 'Pain', 0, at))).toEqual([]);
  });

  it('rejects bad ids, dates, refs and unknown types', () => {
    expect(validateResource({ resourceType: 'Patient', id: 'bad id!' })).toHaveLength(1);
    expect(validateResource({ ...makeVital('o', 'p1', 'weight', 70, 'yesterday') })).toHaveLength(
      1,
    );
    expect(
      validateResource({ ...makeVital('o', 'p1', 'weight', 70, at), subject: { reference: 'x' } }),
    ).toHaveLength(1);
    expect(validateResource({ resourceType: 'Device', id: 'd' })[0]?.message).toMatch(
      /unsupported/,
    );
    expect(validateResource(null)).toHaveLength(1);
  });
});

describe('bundles', () => {
  const resources = [makePatient('p1', 'T'), makeVital('o1', 'p1', 'heartRate', 70, at)];

  it('round-trips through JSON', () => {
    const json = JSON.stringify(toBundle(resources, at));
    const back = parseBundle(json);
    expect(back.entry.map((e) => e.resource)).toEqual(resources);
  });

  it('flags duplicates and non-bundles', () => {
    expect(validateBundle(toBundle([...resources, resources[0]!], at))[0]?.message).toMatch(
      /duplicate/,
    );
    expect(validateBundle({ resourceType: 'Patient' })).toHaveLength(1);
    expect(() => parseBundle('{nope')).toThrow(/not valid JSON/);
    expect(() =>
      parseBundle(
        JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'X' } }] }),
      ),
    ).toThrow(/Invalid FHIR Bundle/);
  });
});
