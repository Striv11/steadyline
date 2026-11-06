/**
 * Passwords: scrypt with per-user salt. Sessions: HMAC-SHA256 signed tokens
 * carrying {sub, role, exp}. No third-party crypto dependencies.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role } from './domain/jobs.js';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return timingSafeEqual(actual, expected);
}

export interface Claims {
  sub: string;
  role: Role;
  exp: number; // epoch seconds
  /** Matches users.token_version; bumping that column revokes every earlier token. */
  ver?: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signToken(
  claims: Omit<Claims, 'exp'>,
  secret: string,
  ttlSeconds = 12 * 3600,
): string {
  const body = b64url(
    JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  );
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): Claims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
    return c.exp > Date.now() / 1000 ? c : null;
  } catch {
    return null;
  }
}

/** 6-digit delivery OTP, stored hashed. */
export function newOtp(): { code: string; hash: string } {
  const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
  return { code, hash: hashOtp(code) };
}
export const hashOtp = (code: string) => createHmac('sha256', 'otp').update(code).digest('hex');
