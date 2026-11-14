import { describe, expect, it } from 'vitest';
import type { Observation, Patient } from '../domain/fhir';
import { DecryptError } from './crypto';
import { MemoryStore } from './raw-store';
import { Vault, WrongPassphraseError } from './vault';

const FAST = 1000; // low iterations keep tests quick; production default is 600k
const PASS = 'correct horse battery';

const patient: Patient = { resourceType: 'Patient', id: 'p1', name: [{ text: 'Asha Verma' }] };
const obs = (id: string, t: string, code = '2339-0'): Observation =>
  ({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code }] },
    subject: { reference: 'Patient/p1' },
    effectiveDateTime: t,
    valueQuantity: { value: 6.1, unit: 'mmol/L' },
  }) as Observation;

describe('Vault', () => {
  it('round-trips resources', async () => {
    const s = new MemoryStore();
    const v = await Vault.create(s, PASS, FAST);
    await v.put(patient);
    expect(await v.get('Patient', 'p1')).toEqual(patient);
    expect(await v.get('Patient', 'nope')).toBeUndefined();
    const again = await Vault.unlock(s, PASS);
    expect(await again.get('Patient', 'p1')).toEqual(patient);
  });

  it('rejects a wrong passphrase', async () => {
    const s = new MemoryStore();
    await Vault.create(s, PASS, FAST);
    await expect(Vault.unlock(s, 'wrong passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('never stores plaintext: raw DB has no names, ids or types', async () => {
    const s = new MemoryStore();
    const v = await Vault.create(s, PASS, FAST);
    await v.put(patient);
    await v.put(obs('obs.glucose.7731', '2026-01-01T08:00:00Z'));
    const dump = JSON.stringify([...s.map.entries()]);
    for (const needle of [
      'Asha',
      'Verma',
      'Patient',
      'Observation',
      'obs.glucose.7731',
      '2339-0',
      'mmol',
    ]) {
      expect(dump).not.toContain(needle);
    }
  });

  it('detects tampering with a ciphertext', async () => {
    const s = new MemoryStore();
    const v = await Vault.create(s, PASS, FAST);
    await v.put(patient);
    const [key] = [...s.map.keys()].filter((k) => k.startsWith('r:'));
    const blob = s.map.get(key!)!;
    const flipped = blob[20] === 'A' ? 'B' : 'A';
    s.map.set(key!, blob.slice(0, 20) + flipped + blob.slice(21));
    await expect(v.get('Patient', 'p1')).rejects.toBeInstanceOf(DecryptError);
    await expect(v.query('Patient')).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects a record moved to another slot', async () => {
    const s = new MemoryStore();
    const v = await Vault.create(s, PASS, FAST);
    await v.put(obs('a', '2026-01-01T00:00:00Z'));
    await v.put(obs('b', '2026-01-02T00:00:00Z'));
    const [ka, kb] = [...s.map.keys()].filter((k) => k.startsWith('r:'));
    s.map.set(ka!, s.map.get(kb!)!);
    await expect(v.query('Observation')).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects a tampered header (iterations downgrade breaks the key)', async () => {
    const s = new MemoryStore();
    await Vault.create(s, PASS, FAST);
    const meta = JSON.parse(s.map.get('__meta')!);
    meta.iterations = 1;
    s.map.set('__meta', JSON.stringify(meta));
    await expect(Vault.unlock(s, PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('queries by type, code and time range, sorted', async () => {
    const v = await Vault.create(new MemoryStore(), PASS, FAST);
    await v.putMany([
      patient,
      obs('c', '2026-01-03T00:00:00Z'),
      obs('a', '2026-01-01T00:00:00Z'),
      obs('b', '2026-01-02T00:00:00Z'),
      obs('x', '2026-01-02T00:00:00Z', '8480-6'),
    ]);
    expect((await v.query('Patient')).length).toBe(1);
    const all = await v.observations('2339-0');
    expect(all.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    const some = await v.observations('2339-0', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z');
    expect(some.map((o) => o.id)).toEqual(['b']);
  });

  it('put overwrites and delete removes', async () => {
    const v = await Vault.create(new MemoryStore(), PASS, FAST);
    await v.put(patient);
    await v.put({ ...patient, birthDate: '1980-01-01' });
    expect(await v.count()).toBe(1);
    expect((await v.get<Patient>('Patient', 'p1'))?.birthDate).toBe('1980-01-01');
    await v.delete('Patient', 'p1');
    expect(await v.count()).toBe(0);
  });

  it('lock() makes the vault unusable until unlocked again', async () => {
    const s = new MemoryStore();
    const v = await Vault.create(s, PASS, FAST);
    await v.put(patient);
    v.lock();
    expect(v.locked).toBe(true);
    await expect(v.get('Patient', 'p1')).rejects.toThrow('locked');
  });

  it('refuses to overwrite an existing vault and short passphrases', async () => {
    const s = new MemoryStore();
    await expect(Vault.create(s, 'short', FAST)).rejects.toThrow('at least 8');
    await Vault.create(s, PASS, FAST);
    await expect(Vault.create(s, PASS, FAST)).rejects.toThrow('already exists');
  });
});

describe('Vault CGM series', () => {
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 0, 1);
  const series = (n: number, start = t0) =>
    Array.from({ length: n }, (_, i) => ({ t: start + i * 300_000, mgdl: 100 + (i % 50) }));

  it('stores, merges idempotently and queries by range across days', async () => {
    const v = await Vault.create(new MemoryStore(), PASS, FAST);
    const s = series(800); // spans 3 UTC days (800 * 5 min = 2.8 days from midnight)
    expect(await v.putCgm(s)).toBe(800);
    expect(await v.putCgm(s)).toBe(0);
    // overlapping batch adds only new points; existing values win
    const more = [{ t: t0, mgdl: 999 }, ...series(10, t0 + 800 * 300_000)];
    expect(await v.putCgm(more)).toBe(10);
    expect(await v.cgmCount()).toBe(810);
    const all = await v.cgm();
    expect(all[0]).toEqual({ t: t0, mgdl: 100 });
    expect(all.map((x) => x.t)).toEqual([...all.map((x) => x.t)].sort((a, b) => a - b));
    const mid = await v.cgm(t0 + day, t0 + 2 * day);
    expect(mid).toHaveLength(288);
    expect(mid.every((x) => x.t >= t0 + day && x.t < t0 + 2 * day)).toBe(true);
  });

  it('is encrypted, survives re-unlock and does not disturb resource queries', async () => {
    const s = new MemoryStore();
    const v = await Vault.create(s, PASS, FAST);
    await v.put(patient);
    await v.putCgm(series(50));
    expect(await v.count()).toBe(1);
    expect(await v.query('Observation')).toEqual([]);
    const raw = JSON.stringify([...s.map.entries()]);
    expect(raw).not.toContain('"mgdl"');
    const again = await Vault.unlock(s, PASS);
    expect(await again.cgmCount()).toBe(50);
  });

  it('detects tampering and refuses when locked', async () => {
    const s = new MemoryStore();
    const v = await Vault.create(s, PASS, FAST);
    await v.putCgm(series(5));
    const [k] = [...s.map.keys()].filter((x) => x.startsWith('c:'));
    const blob = s.map.get(k!)!;
    s.map.set(k!, blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
    await expect(v.cgm()).rejects.toBeInstanceOf(DecryptError);
    v.lock();
    await expect(v.putCgm(series(1))).rejects.toThrow('locked');
  });

  it('ignores non-finite samples', async () => {
    const v = await Vault.create(new MemoryStore(), PASS, FAST);
    expect(
      await v.putCgm([
        { t: NaN, mgdl: 100 },
        { t: t0, mgdl: Infinity },
        { t: t0, mgdl: 90 },
      ]),
    ).toBe(1);
  });
});
