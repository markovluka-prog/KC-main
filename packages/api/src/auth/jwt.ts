/**
 * Phase 3 T3.9 — hybrid session tokens.
 *   - Access token: JWT signed Ed25519, 15-minute TTL, in-memory client.
 *   - Refresh token: opaque 32-byte random, 30-day TTL, hash stored in
 *     `sessions`. Rotation on every refresh. HttpOnly cookie on the wire.
 *
 * NR-2: changing claims/algo invalidates all live tokens. Coordinate
 * deploys to clear sessions before rotating signer key.
 */
import { SignJWT, importJWK, jwtVerify, type JWK } from 'jose';
import crypto from 'node:crypto';
import { loadEnv } from '../env.js';

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let privateKey: CryptoKey | null = null;
let publicKey: CryptoKey | null = null;

async function loadKeys(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  if (privateKey && publicKey) return { privateKey, publicKey };
  const env = loadEnv();
  const jwk = JSON.parse(env.JWT_PRIVATE_KEY_JWK) as JWK;
  privateKey = (await importJWK(jwk, 'EdDSA')) as CryptoKey;
  // Strip private fields to get public-only JWK.
  const pubJwk: JWK = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  publicKey = (await importJWK(pubJwk, 'EdDSA')) as CryptoKey;
  return { privateKey, publicKey };
}

export interface AccessTokenPayload {
  sub: string; // user id
  iss: string;
  aud: string;
  /** Token version — increment to mass-invalidate. */
  v: number;
  /** True for anonymous guest tokens (no DB user, no refresh). */
  guest?: boolean;
}

/** Guest sessions get a longer TTL (no refresh token) so a casual online match
 * survives without re-auth. See lobby room/guest flow. */
export const GUEST_TTL_SEC = 3 * 60 * 60;

export async function signAccessToken(
  userId: string,
  opts?: { guest?: boolean; ttlSec?: number },
): Promise<string> {
  const { privateKey: priv } = await loadKeys();
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { v: 1 };
  if (opts?.guest) claims.guest = true;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts?.ttlSec ?? ACCESS_TTL_SEC))
    .setIssuer('kc-api')
    .setAudience('kc-web')
    .sign(priv);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { publicKey: pub } = await loadKeys();
    const res = await jwtVerify(token, pub, {
      issuer: 'kc-api',
      audience: 'kc-web',
      algorithms: ['EdDSA'],
    });
    return res.payload as unknown as AccessTokenPayload;
  } catch {
    return null;
  }
}

/** 32-byte URL-safe random; used as the refresh-token plaintext. */
export function generateRefreshToken(): { token: string; expiresAt: Date } {
  const buf = crypto.randomBytes(32);
  return {
    token: buf.toString('base64url'),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  };
}
