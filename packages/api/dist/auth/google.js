/**
 * Phase 3 T3.6 — Google OIDC flow via `openid-client` v6.
 *
 * Used only when NODE_ENV=production (or any non-dev-bypass build with the
 * client id/secret + redirect URI set). Locally, the routes return 501.
 *
 * Flow:
 *   1. GET /auth/google/start    → build authorize URL, set state+nonce
 *      cookies, 302 to Google.
 *   2. Google redirects to /auth/google/callback?state=...&code=...
 *   3. We verify state, exchange code for id_token, find or create user
 *      with identity (provider='google', provider_sub=Google's sub claim).
 *   4. Issue our own access JWT + refresh cookie just like password login.
 */
import * as oidcClient from 'openid-client';
import crypto from 'node:crypto';
import { loadEnv } from '../env.js';
const GOOGLE_ISSUER = 'https://accounts.google.com';
let cached = null;
export async function getGoogleConfig() {
    if (cached)
        return cached;
    const env = loadEnv();
    if (!env.GOOGLE_OIDC_CLIENT_ID ||
        !env.GOOGLE_OIDC_CLIENT_SECRET ||
        !env.GOOGLE_OIDC_REDIRECT_URI) {
        throw new Error('Google OIDC env vars missing — set GOOGLE_OIDC_CLIENT_ID/SECRET/REDIRECT_URI');
    }
    const config = await oidcClient.discovery(new URL(GOOGLE_ISSUER), env.GOOGLE_OIDC_CLIENT_ID, env.GOOGLE_OIDC_CLIENT_SECRET);
    cached = {
        config,
        clientId: env.GOOGLE_OIDC_CLIENT_ID,
        redirectUri: env.GOOGLE_OIDC_REDIRECT_URI,
    };
    return cached;
}
export async function buildAuthorizeUrl() {
    const { config, redirectUri } = await getGoogleConfig();
    const state = oidcClient.randomState();
    const nonce = oidcClient.randomNonce();
    const codeVerifier = oidcClient.randomPKCECodeVerifier();
    const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);
    const params = new URLSearchParams({
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        response_type: 'code',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
    });
    const authorizeUrl = oidcClient.buildAuthorizationUrl(config, params).href;
    return { url: authorizeUrl, state, nonce, codeVerifier };
}
export async function exchangeCallback(currentUrl, expected) {
    const { config } = await getGoogleConfig();
    const tokens = await oidcClient.authorizationCodeGrant(config, currentUrl, {
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        pkceCodeVerifier: expected.codeVerifier,
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string') {
        throw new Error('google id_token has no sub claim');
    }
    return {
        sub: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : null,
        emailVerified: claims['email_verified'] === true,
        name: typeof claims.name === 'string' ? claims.name : null,
        picture: typeof claims.picture === 'string' ? claims.picture : null,
    };
}
/**
 * Cookie-storage for the OIDC "state bag" (state + nonce + PKCE verifier).
 * We use a single signed cookie holding the three values JSON-encoded.
 * Cookie is set on /auth/google/start, read+cleared in /auth/google/callback.
 */
const OIDC_STATE_COOKIE = 'kc_oidc_state';
export function packStateBag(bag) {
    const json = JSON.stringify(bag);
    const sig = signBag(json);
    return Buffer.from(JSON.stringify({ json, sig })).toString('base64url');
}
export function unpackStateBag(raw) {
    try {
        const { json, sig } = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
        if (signBag(json) !== sig)
            return null;
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
function signBag(json) {
    // HMAC-SHA256 with the JWT private key as the symmetric key. Reusing
    // the JWT key avoids adding another secret; the bag is short-lived
    // (10 min cookie) so rotation isn't a concern.
    const env = loadEnv();
    return crypto.createHmac('sha256', env.JWT_PRIVATE_KEY_JWK).update(json).digest('base64url');
}
export const OIDC_STATE_COOKIE_NAME = OIDC_STATE_COOKIE;
export const OIDC_STATE_COOKIE_MAX_AGE_SEC = 10 * 60;
