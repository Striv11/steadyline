/** Minimal async key/value interface the vault persists through. */
export interface RawStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export class MemoryStore implements RawStore {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key);
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()];
  }
  async clear() {
    this.map.clear();
  }
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB-backed store: one object store of string values. */
export class IdbStore implements RawStore {
  private dbp: Promise<IDBDatabase> | undefined;
  constructor(
    private readonly name = 'steadyline',
    private readonly storeName = 'kv',
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  private async os(mode: IDBTransactionMode) {
    return (await this.db()).transaction(this.storeName, mode).objectStore(this.storeName);
  }

  async get(key: string) {
    return (await wrap((await this.os('readonly')).get(key))) as string | undefined;
  }
  async put(key: string, value: string) {
    await wrap((await this.os('readwrite')).put(value, key));
  }
  async delete(key: string) {
    await wrap((await this.os('readwrite')).delete(key));
  }
  async keys() {
    return (await wrap((await this.os('readonly')).getAllKeys())).map(String);
  }
  async clear() {
    await wrap((await this.os('readwrite')).clear());
  }
}
