/**
 * Phase 3 T3.10 — REST endpoints for authentication.
 *
 * /auth/signup           — POST email/password/displayName → user
 * /auth/login            — POST email/password             → accessToken + user
 * /auth/refresh          — POST (cookie)                   → new accessToken
 * /auth/logout           — POST (cookie or bearer)         → 204
 * /auth/me               — GET                             → user
 * /auth/google/start     — GET                             → OIDC redirect
 * /auth/google/callback  — GET                             → completes flow
 * /auth/forgot-password  — POST                            → 204
 * /auth/reset-password   — POST token + newPassword        → 204
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import {
  createSession,
  createUserWithPassword,
  findActiveSessionByToken,
  findOrCreateGoogleUser,
  findPasswordIdentity,
  findUserByEmail,
  findUserById,
  revokeSession,
  rotateSessionToken,
  touchLastLogin,
} from '../db/repos/users.js';
import { hashPassword, passwordPolicyError, verifyPassword } from '../auth/password.js';
import {
  OIDC_STATE_COOKIE_MAX_AGE_SEC,
  OIDC_STATE_COOKIE_NAME,
  buildAuthorizeUrl,
  exchangeCallback,
  packStateBag,
  unpackStateBag,
} from '../auth/google.js';
import { randomUUID } from 'node:crypto';
import { GUEST_TTL_SEC, generateRefreshToken, signAccessToken } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';
import { loadEnv } from '../env.js';

const REFRESH_COOKIE = 'kc_refresh';
// Defense-in-depth: reject angle brackets in displayName so a careless
// .innerHTML render can't produce stored XSS. Frontend MUST still escape
// on render — this is belt-and-braces, not the primary defence.
const displayNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[^<>]+$/, 'displayName must not contain angle brackets');

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: displayNameSchema,
});
const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

interface PublicUser {
  id: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  isGuest: boolean;
}

function toPublicUser(u: {
  id: string;
  display_name: string;
  email: string | null;
  email_verified_at: Date | null;
  is_guest: boolean;
}): PublicUser {
  return {
    id: u.id,
    displayName: u.display_name,
    email: u.email,
    emailVerified: !!u.email_verified_at,
    isGuest: u.is_guest,
  };
}

const authPlugin: FastifyPluginAsync = async (app) => {
  const env = loadEnv();
  const cookieSecure = env.NODE_ENV === 'production';
  const cookieDomain = undefined; // tighten in Phase 6 once domain is known.

  // T3.11 — tighter rate-limit on login/signup. Disabled in test env.
  const rateConfig = (max: number, window: string) =>
    env.NODE_ENV === 'test' ? undefined : { config: { rateLimit: { max, timeWindow: window } } };

  app.post('/auth/signup', rateConfig(3, '1 hour') ?? {}, async (req, reply) => {
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'invalid-body', message: parsed.error.message });
    }
    const { email, password, displayName } = parsed.data;
    const policyErr = passwordPolicyError(password);
    if (policyErr) return reply.code(400).send({ code: 'weak-password', message: policyErr });
    const existing = await findUserByEmail(pool, email);
    if (existing) return reply.code(409).send({ code: 'email-taken', message: 'email in use' });
    const hash = await hashPassword(password);
    const user = await createUserWithPassword(pool, email, hash, displayName);
    return reply.code(201).send(toPublicUser(user));
  });

  // Guest session: anonymous access token (no DB row, no refresh) so a player
  // can create/join an online room without registering. Longer TTL (~3h).
  app.post('/auth/guest', rateConfig(20, '1 hour') ?? {}, async (_req, reply) => {
    const id = `guest_${randomUUID()}`;
    const accessToken = await signAccessToken(id, { guest: true, ttlSec: GUEST_TTL_SEC });
    return reply.send({
      accessToken,
      user: { id, displayName: 'Гость', email: null, emailVerified: false, isGuest: true },
    });
  });

  app.post('/auth/login', rateConfig(5, '15 minutes') ?? {}, async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'invalid-body', message: parsed.error.message });
    }
    const { email, password } = parsed.data;
    const row = await findPasswordIdentity(pool, email);
    if (!row || !row.identity.password_hash) {
      return reply
        .code(401)
        .send({ code: 'bad-credentials', message: 'invalid email or password' });
    }
    const ok = await verifyPassword(row.identity.password_hash, password);
    if (!ok) {
      return reply
        .code(401)
        .send({ code: 'bad-credentials', message: 'invalid email or password' });
    }
    await touchLastLogin(pool, row.user.id);
    const { token: refreshToken, expiresAt } = generateRefreshToken();
    await createSession(pool, {
      userId: row.user.id,
      refreshToken,
      expiresAt,
      ua: req.headers['user-agent']?.toString() ?? null,
      ip: req.ip,
    });
    const accessToken = await signAccessToken(row.user.id);
    reply.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/api/auth',
      domain: cookieDomain,
      expires: expiresAt,
    });
    return { accessToken, user: toPublicUser(row.user) };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!cookie) return reply.code(401).send({ code: 'no-refresh', message: 'no refresh token' });
    const session = await findActiveSessionByToken(pool, cookie);
    if (!session) {
      return reply.code(401).send({ code: 'invalid-refresh', message: 'session not found' });
    }
    const { token: newToken, expiresAt } = generateRefreshToken();
    const rotated = await rotateSessionToken(pool, session.id, newToken, expiresAt);
    if (!rotated)
      return reply.code(401).send({ code: 'rotation-failed', message: 'session revoked' });
    const accessToken = await signAccessToken(session.user_id);
    reply.setCookie(REFRESH_COOKIE, newToken, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/api/auth',
      domain: cookieDomain,
      expires: expiresAt,
    });
    return { accessToken };
  });

  app.post('/auth/logout', async (req, reply) => {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (cookie) {
      const session = await findActiveSessionByToken(pool, cookie);
      if (session) await revokeSession(pool, session.id);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.userId!;
    if (userId.startsWith('guest_')) {
      return reply.code(403).send({ code: 'guest', message: 'guest has no profile' });
    }
    const user = await findUserById(pool, userId);
    if (!user) return reply.code(401).send({ code: 'no-user', message: 'user not found' });
    return toPublicUser(user);
  });

  // Google OIDC start: redirect to Google's authorize URL after storing
  // the OIDC state-bag (state + nonce + PKCE verifier) in a short-lived
  // signed cookie. Callback verifies the bag and exchanges the code.
  app.get('/auth/google/start', async (req, reply) => {
    if (env.AUTH_MODE === 'dev-bypass') {
      return reply
        .code(501)
        .send({ code: 'dev-bypass', message: 'OAuth disabled in dev-bypass mode' });
    }
    try {
      const authz = await buildAuthorizeUrl();
      const bag = packStateBag({
        state: authz.state,
        nonce: authz.nonce,
        codeVerifier: authz.codeVerifier,
      });
      reply.setCookie(OIDC_STATE_COOKIE_NAME, bag, {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax',
        path: '/api/auth/google',
        maxAge: OIDC_STATE_COOKIE_MAX_AGE_SEC,
      });
      return reply.redirect(authz.url);
    } catch (err) {
      req.log.error({ err }, 'google oidc start failed');
      return reply.code(500).send({ code: 'oidc-init-failed' });
    }
  });

  app.get('/auth/google/callback', async (req, reply) => {
    if (env.AUTH_MODE === 'dev-bypass') {
      return reply.code(501).send({ code: 'dev-bypass' });
    }
    const cookie = (req.cookies as Record<string, string> | undefined)?.[OIDC_STATE_COOKIE_NAME];
    if (!cookie) return reply.code(400).send({ code: 'no-state', message: 'oidc state missing' });
    const bag = unpackStateBag(cookie);
    if (!bag) return reply.code(400).send({ code: 'bad-state', message: 'oidc state invalid' });
    reply.clearCookie(OIDC_STATE_COOKIE_NAME, { path: '/api/auth/google' });

    // Reconstruct the full URL the OAuth client expects.
    const proto = req.headers['x-forwarded-proto']?.toString() ?? req.protocol;
    const host = req.headers['x-forwarded-host']?.toString() ?? req.hostname;
    const currentUrl = new URL(`${proto}://${host}${req.url}`);

    let profile;
    try {
      profile = await exchangeCallback(currentUrl, bag);
    } catch (err) {
      req.log.error({ err }, 'google oidc callback exchange failed');
      return reply.code(401).send({ code: 'oidc-exchange-failed' });
    }

    const displayName = profile.name ?? profile.email?.split('@')[0] ?? 'Player';
    const user = await findOrCreateGoogleUser(pool, profile.sub, {
      email: profile.emailVerified ? profile.email : null,
      displayName,
    });
    await touchLastLogin(pool, user.id);

    const { token: refreshToken, expiresAt } = generateRefreshToken();
    await createSession(pool, {
      userId: user.id,
      refreshToken,
      expiresAt,
      ua: req.headers['user-agent']?.toString() ?? null,
      ip: req.ip,
    });
    const accessToken = await signAccessToken(user.id);
    reply.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/api/auth',
      expires: expiresAt,
    });
    // Hand the access token to the web client via a one-shot HTML page
    // that posts a message to opener and closes. Avoids putting the token
    // in URL/fragment where it could leak via history.
    return reply.type('text/html').send(`<!doctype html>
<meta charset="utf-8">
<title>Signing you in…</title>
<script>
(function() {
  var payload = { type: 'kc-oauth', accessToken: ${JSON.stringify(accessToken)}, user: ${JSON.stringify(
    toPublicUser(user),
  )} };
  if (window.opener) {
    window.opener.postMessage(payload, '*');
    window.close();
  } else {
    // Fallback — store and redirect home.
    sessionStorage.setItem('kc.pendingAuth', JSON.stringify(payload));
    location.href = '/';
  }
})();
</script>`);
  });

  // Apple OIDC, verify-email, forgot/reset — stubs for now.
  app.post('/auth/verify-email', async (_req, reply) => reply.code(501).send({ code: 'todo' }));
  app.post('/auth/forgot-password', async (_req, reply) => reply.code(501).send({ code: 'todo' }));
  app.post('/auth/reset-password', async (_req, reply) => reply.code(501).send({ code: 'todo' }));
};

// Plain plugin (not wrapped in fastify-plugin) so the `prefix` option in
// main.ts is honoured — fastify-plugin escapes encapsulation and would
// register all routes at root.
export const registerAuthRoutes = authPlugin;
