/**
 * WebCrypto primitives for the encrypted store.
 *
 * One PBKDF2-SHA256 derivation yields 64 bytes, split into an AES-256-GCM key
 * (record encryption) and an HMAC-SHA256 key (opaque record keys), so the
 * database never contains resource types or ids in plaintext.
 */

export const DEFAULT_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-SHA256
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface VaultKeys {
  aes: CryptoKey;
  mac: CryptoKey;
}

export class DecryptError extends Error {
  constructor() {
    super('Could not decrypt: wrong passphrase or data has been modified');
    this.name = 'DecryptError';
  }
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveKeys(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<VaultKeys> {
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base,
      512,
    ),
  );
  const aes = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const mac = await crypto.subtle.importKey(
    'raw',
    bits.slice(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  bits.fill(0);
  return { aes, mac };
}

/** Deterministic opaque storage key for a logical record name. */
export async function opaqueKey(keys: VaultKeys, name: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', keys.mac, enc.encode(name));
  return toB64(new Uint8Array(sig)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
}

/**
 * Encrypts to `iv(12) || ciphertext+tag`. `aad` binds the ciphertext to its
 * storage key so records cannot be swapped between slots undetected.
 */
export async function seal(keys: VaultKeys, plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      keys.aes,
      enc.encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

export async function open(keys: VaultKeys, sealed: string, aad: string): Promise<string> {
  try {
    const raw = fromB64(sealed);
    if (raw.length < 12 + 16) throw new DecryptError();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(aad) },
      keys.aes,
      raw.slice(12),
    );
    return dec.decode(pt);
  } catch {
    throw new DecryptError();
  }
}
