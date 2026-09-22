/**
 * Single shared Supabase client for the web app.
 *
 * URL + anon/publishable key come from Vite env (see packages/web/.env).
 * The anon key is meant to be public — RLS on the database enforces access.
 *
 * Desktop note: the app runs inside a WKWebView served from the custom
 * `kcapp://app` origin, so `detectSessionInUrl` is off — the OAuth redirect
 * is handled natively (ASWebAuthenticationSession) and the session is set
 * back into this client manually.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

export function getSupabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in packages/web/.env',
    );
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: globalThis.localStorage,
      },
    });
  }
  return client;
}
