import type { Observation, Resource } from '../domain/fhir';
import {
  DEFAULT_ITERATIONS,
  DecryptError,
  deriveKeys,
  fromB64,
  opaqueKey,
  open,
  randomBytes,
  seal,
  toB64,
  type VaultKeys,
} from './crypto';
import type { RawStore } from './raw-store';

const META_KEY = '__meta';
const CHECK_TEXT = 'steadyline-vault-v1';
const RES_PREFIX = 'r:';

interface Meta {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  /** Encrypted known string; decrypting it proves the passphrase is right. */
  check: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase');
    this.name = 'WrongPassphraseError';
  }
}

/**
 * Typed repository of FHIR resources, encrypted at rest.
 * Stored values are `iv||ciphertext` blobs under HMAC-derived keys, so the raw
 * database reveals only the number and approximate size of records.
 */
export class Vault {
  private keys: VaultKeys | undefined;

  private constructor(
    private readonly store: RawStore,
    keys: VaultKeys,
  ) {
    this.keys = keys;
  }

  static async exists(store: RawStore): Promise<boolean> {
    return (await store.get(META_KEY)) !== undefined;
  }

  static async create(
    store: RawStore,
    passphrase: string,
    iterations = DEFAULT_ITERATIONS,
  ): Promise<Vault> {
    if (await Vault.exists(store)) throw new Error('A vault already exists in this store');
    if (passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
    const salt = randomBytes(16);
    const keys = await deriveKeys(passphrase, salt, iterations);
    const meta: Meta = {
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iterations,
      salt: toB64(salt),
      check: await seal(keys, CHECK_TEXT, META_KEY),
    };
    await store.put(META_KEY, JSON.stringify(meta));
    return new Vault(store, keys);
  }

  static async unlock(store: RawStore, passphrase: string): Promise<Vault> {
    const raw = await store.get(META_KEY);
    if (raw === undefined) throw new Error('No vault in this store');
    const meta = JSON.parse(raw) as Meta;
    const keys = await deriveKeys(passphrase, fromB64(meta.salt), meta.iterations);
    try {
      if ((await open(keys, meta.check, META_KEY)) !== CHECK_TEXT) throw new DecryptError();
    } catch {
      throw new WrongPassphraseError();
    }
    return new Vault(store, keys);
  }

  /** Drops the in-memory keys. Further calls throw until unlocked again. */
  lock(): void {
    this.keys = undefined;
  }

  get locked(): boolean {
    return this.keys === undefined;
  }

  private k(): VaultKeys {
    if (!this.keys) throw new Error('Vault is locked');
    return this.keys;
  }

  async put(resource: Resource): Promise<void> {
    const keys = this.k();
    const key = RES_PREFIX + (await opaqueKey(keys, `${resource.resourceType}/${resource.id}`));
    await this.store.put(key, await seal(keys, JSON.stringify(resource), key));
  }

  async putMany(resources: Resource[]): Promise<void> {
    for (const r of resources) await this.put(r);
  }

  async get<T extends Resource>(type: T['resourceType'], id: string): Promise<T | undefined> {
    const keys = this.k();
    const key = RES_PREFIX + (await opaqueKey(keys, `${type}/${id}`));
    const sealed = await this.store.get(key);
    return sealed === undefined ? undefined : (JSON.parse(await open(keys, sealed, key)) as T);
  }

  async delete(type: Resource['resourceType'], id: string): Promise<void> {
    const keys = this.k();
    await this.store.delete(RES_PREFIX + (await opaqueKey(keys, `${type}/${id}`)));
  }

  /** All resources of one type, optionally filtered. Throws DecryptError on tampering. */
  async query<T extends Resource>(
    type: T['resourceType'],
    filter?: (r: T) => boolean,
  ): Promise<T[]> {
    const keys = this.k();
    const out: T[] = [];
    for (const key of await this.store.keys()) {
      if (!key.startsWith(RES_PREFIX)) continue;
      const sealed = (await this.store.get(key))!;
      const r = JSON.parse(await open(keys, sealed, key)) as Resource;
      if (r.resourceType === type && (!filter || filter(r as T))) out.push(r as T);
    }
    return out;
  }

  /** Observations with a given coding, within [from, to) ISO instants, oldest first. */
  async observations(code: string, from?: string, to?: string): Promise<Observation[]> {
    const rows = await this.query<Observation>('Observation', (o) => {
      const t = o.effectiveDateTime;
      return (
        !!o.code.coding?.some((c) => c.code === code) &&
        (from === undefined || (t !== undefined && t >= from)) &&
        (to === undefined || (t !== undefined && t < to))
      );
    });
    return rows.sort((a, b) =>
      (a.effectiveDateTime ?? '').localeCompare(b.effectiveDateTime ?? ''),
    );
  }

  async count(): Promise<number> {
    return (await this.store.keys()).filter((k) => k.startsWith(RES_PREFIX)).length;
  }
}
