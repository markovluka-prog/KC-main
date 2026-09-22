/**
 * Native Google sign-in bridge for the macOS WKWebView wrapper.
 *
 * In the desktop app, OAuth can't run inside the WKWebView (Google blocks
 * embedded webviews and the custom `kcapp://app` origin), so we hand off to the
 * native side: post a message to `window.webkit.messageHandlers.auth`, which
 * runs an `ASWebAuthenticationSession`, captures the redirect to
 * `kcauth://callback`, and hands the Supabase tokens back by calling the global
 * `window.__kcAuthResult(json)` we install here.
 *
 * Once we have the tokens we call `getSupabase().auth.setSession(...)` to
 * establish the session in the shared client (which persists it to
 * localStorage and starts auto-refresh).
 */
import type { User } from '@supabase/supabase-js';
import { getSupabase } from './supabase.js';

/** Shape of the JSON the native side passes to `window.__kcAuthResult`. */
interface NativeAuthResult {
  ok: boolean;
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

interface AuthMessageHandler {
  postMessage(message: unknown): void;
}

interface WebkitBridge {
  messageHandlers?: {
    auth?: AuthMessageHandler;
  };
}

declare global {
  interface Window {
    webkit?: WebkitBridge;
    __kcAuthResult?: (json: string) => void;
  }
}

export class GoogleSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleSignInError';
  }
}

/** True when running inside the native macOS wrapper with the auth bridge. */
export function isNativeAuthAvailable(): boolean {
  return Boolean(window.webkit?.messageHandlers?.auth);
}

/** Resolve the in-flight native callback, if any. Guards against double-calls. */
let pendingResolve: ((result: NativeAuthResult) => void) | null = null;

function installCallback(): void {
  if (window.__kcAuthResult) return;
  window.__kcAuthResult = (json: string) => {
    const resolve = pendingResolve;
    pendingResolve = null;
    if (!resolve) return;
    let parsed: NativeAuthResult;
    try {
      parsed = JSON.parse(json) as NativeAuthResult;
    } catch {
      parsed = { ok: false, error: 'Invalid response from native auth.' };
    }
    resolve(parsed);
  };
}

/**
 * Run the native Google OAuth flow and establish the Supabase session.
 * Resolves with the signed-in Supabase {@link User}.
 *
 * @throws {GoogleSignInError} when not running natively, on user cancellation,
 *   on a native error, or when Supabase rejects the tokens.
 */
export async function signInWithGoogle(): Promise<User> {
  const handler = window.webkit?.messageHandlers?.auth;
  if (!handler) {
    throw new GoogleSignInError(
      'Вход через Google доступен только в приложении.',
    );
  }
  if (pendingResolve) {
    throw new GoogleSignInError('Вход через Google уже выполняется.');
  }

  installCallback();

  const result = await new Promise<NativeAuthResult>((resolve) => {
    pendingResolve = resolve;
    handler.postMessage({ action: 'google' });
  });

  if (!result.ok) {
    if (result.error === 'cancelled') {
      throw new GoogleSignInError('Вход отменён.');
    }
    throw new GoogleSignInError(result.error || 'Не удалось войти через Google.');
  }
  if (!result.access_token || !result.refresh_token) {
    throw new GoogleSignInError('Не получены токены от Google.');
  }

  const { data, error } = await getSupabase().auth.setSession({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
  });
  if (error) {
    throw new GoogleSignInError(error.message);
  }
  if (!data.user) {
    throw new GoogleSignInError('Сессия Google не содержит пользователя.');
  }
  return data.user;
}
