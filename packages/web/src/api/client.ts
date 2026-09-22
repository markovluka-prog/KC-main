/**
 * Supabase-backed implementation of the app's API client.
 *
 * The public surface is unchanged from the original Fastify-targeting client so
 * main.ts keeps working: auth (email/password, guest, session restore), progress
 * sync, and lobby/match stubs. Auth/progress now go through Supabase; lobby &
 * realtime match are migrated in a later phase.
 *
 * Sessions persist in localStorage via supabase-js (see net/supabase.ts), which
 * also auto-refreshes the access token — so the in-memory token cache here just
 * mirrors what supabase-js holds, for the bits of main.ts that read it directly.
 */
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase } from '../net/supabase.js';
import { SupabaseLobby } from '../net/lobby.js';
import { signInWithGoogle as nativeSignInWithGoogle, GoogleSignInError } from '../net/auth-google.js';

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(err: ApiError) {
    super(err.message);
    this.name = 'ApiClientError';
    this.status = err.status;
    this.code = err.code;
  }
}

export interface SessionUser {
  id: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  isGuest: boolean;
}

interface ApiClientOpts {
  baseUrl: string;
  /** Called when the session is lost (sign-out / refresh failure). */
  onAuthLost?: () => void;
}

export type PlayerSlot = 1 | 2;

export interface GuestSession {
  accessToken: string;
  user: SessionUser;
}

export interface CreateRoomResult {
  code: string;
  matchId: string;
  you: PlayerSlot;
}

export interface JoinRoomResult {
  matchId: string;
  you: PlayerSlot;
  code: string;
}

export type QueueResult =
  | { paired: false; position: number }
  | { paired: true; matchId: string; you: PlayerSlot };

export type RematchResult =
  | { ready: false; waiting: true; you: PlayerSlot; matchId: null }
  | { ready: true; matchId: string; you: PlayerSlot };

function mapUser(user: User): SessionUser {
  const meta = (user.user_metadata ?? {}) as { display_name?: string; full_name?: string };
  const displayName =
    meta.display_name ||
    meta.full_name ||
    (user.email ? user.email.split('@')[0] : '') ||
    'Игрок';
  return {
    id: user.id,
    displayName,
    email: user.email ?? null,
    emailVerified: Boolean(user.email_confirmed_at),
    isGuest: user.is_anonymous === true,
  };
}

export class ApiClient {
  private accessToken: string | null = null;
  private readonly sb = getSupabase();
  private readonly lobby = new SupabaseLobby();

  constructor(private readonly opts: ApiClientOpts) {
    this.sb.auth.onAuthStateChange((event, session: Session | null) => {
      this.accessToken = session?.access_token ?? null;
      if (event === 'SIGNED_OUT') this.opts.onAuthLost?.();
    });
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  // ---- Auth -----------------------------------------------------------------

  async signup(email: string, password: string, displayName: string): Promise<SessionUser> {
    const { data, error } = await this.sb.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw this.wrap(error);
    if (data.session) this.accessToken = data.session.access_token;
    if (!data.user) {
      throw new ApiClientError({
        status: 500,
        code: 'signup-failed',
        message: 'Не удалось создать аккаунт.',
      });
    }
    return mapUser(data.user);
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; user: SessionUser }> {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw this.wrap(error);
    this.accessToken = data.session.access_token;
    return { accessToken: data.session.access_token, user: mapUser(data.user) };
  }

  /**
   * Google sign-in via the native macOS wrapper (ASWebAuthenticationSession).
   * The native side returns Supabase tokens, which net/auth-google feeds into
   * `setSession`; here we just mirror the access token and map the user.
   * Throws an {@link ApiClientError} (so callers can show `err.message`).
   */
  async signInWithGoogle(): Promise<{ accessToken: string; user: SessionUser }> {
    try {
      const user = await nativeSignInWithGoogle();
      const { data } = await this.sb.auth.getSession();
      this.accessToken = data.session?.access_token ?? null;
      return {
        accessToken: this.accessToken ?? '',
        user: mapUser(user),
      };
    } catch (err) {
      if (err instanceof GoogleSignInError) {
        throw new ApiClientError({ status: 400, code: 'google-signin', message: err.message });
      }
      throw err;
    }
  }

  async logout(): Promise<void> {
    await this.sb.auth.signOut();
    this.accessToken = null;
  }

  async me(): Promise<SessionUser> {
    const { data, error } = await this.sb.auth.getUser();
    if (error || !data.user) {
      throw new ApiClientError({ status: 401, code: 'no-session', message: 'Нет активной сессии.' });
    }
    return mapUser(data.user);
  }

  /** Update the player's display name (nickname). Caller is responsible for
   *  validating/sanitising it first (see util/nickname.ts). */
  async updateDisplayName(displayName: string): Promise<SessionUser> {
    const { data, error } = await this.sb.auth.updateUser({ data: { display_name: displayName } });
    if (error || !data.user) throw this.wrap(error ?? { message: 'update-failed' });
    return mapUser(data.user);
  }

  /** Restore a persisted session (supabase-js auto-refreshes the token). */
  async refresh(): Promise<boolean> {
    const { data } = await this.sb.auth.getSession();
    if (data.session) {
      this.accessToken = data.session.access_token;
      return true;
    }
    return false;
  }

  /** Anonymous guest session (requires anonymous sign-ins enabled in Supabase). */
  async guest(): Promise<GuestSession> {
    const { data, error } = await this.sb.auth.signInAnonymously();
    if (error) throw this.wrap(error);
    if (!data.session || !data.user) {
      throw new ApiClientError({
        status: 500,
        code: 'guest-failed',
        message: 'Гостевой вход недоступен. Включите Anonymous sign-ins в Supabase.',
      });
    }
    this.accessToken = data.session.access_token;
    return { accessToken: data.session.access_token, user: mapUser(data.user) };
  }

  async forgotPassword(email: string): Promise<void> {
    const { error } = await this.sb.auth.resetPasswordForEmail(email);
    if (error) throw this.wrap(error);
  }

  async resetPassword(_token: string, newPassword: string): Promise<void> {
    const { error } = await this.sb.auth.updateUser({ password: newPassword });
    if (error) throw this.wrap(error);
  }

  // ---- Cross-device campaign progress ---------------------------------------

  async getProgress(): Promise<unknown | null> {
    const uid = await this.currentUserId();
    if (!uid) return null;
    const { data, error } = await this.sb
      .from('progress')
      .select('data')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) return null; // best-effort; localStorage stays source of truth
    return (data as { data?: unknown } | null)?.data ?? null;
  }

  async putProgress(data: unknown): Promise<void> {
    const uid = await this.currentUserId();
    if (!uid) return;
    await this.sb
      .from('progress')
      .upsert({ user_id: uid, data, updated_at: new Date().toISOString() });
  }

  // ---- Online lobby (delegated to the Supabase lobby scaffold) --------------

  async createRoom(): Promise<CreateRoomResult> {
    return this.lobby.createRoom();
  }
  async joinRoom(code: string): Promise<JoinRoomResult> {
    return this.lobby.joinRoom(code);
  }
  async roomStatus(code: string): Promise<{ exists: boolean; matchId?: string; status?: string }> {
    return this.lobby.roomStatus(code);
  }
  async queue(): Promise<QueueResult> {
    return this.lobby.queue();
  }
  async leaveQueue(): Promise<void> {
    return this.lobby.leaveQueue();
  }
  async lobbyMe(): Promise<{
    state: 'idle' | 'queued' | 'in_match';
    matchId?: string;
    you?: PlayerSlot;
    position?: number;
    status?: string;
  }> {
    return this.lobby.lobbyMe();
  }
  async rematch(matchId: string): Promise<RematchResult> {
    return this.lobby.rematch(matchId);
  }

  // ---- helpers --------------------------------------------------------------

  private async currentUserId(): Promise<string | null> {
    const { data } = await this.sb.auth.getSession();
    return data.session?.user.id ?? null;
  }

  private wrap(error: { message: string; status?: number; code?: string }): ApiClientError {
    return new ApiClientError({
      status: error.status ?? 400,
      code: error.code ?? 'auth-error',
      message: translateAuthError(error.message),
    });
  }
}

/** Surface common Supabase auth errors in Russian for the UI. */
function translateAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Неверный email или пароль.';
  if (m.includes('user already registered')) return 'Этот email уже зарегистрирован.';
  if (m.includes('email not confirmed')) return 'Подтвердите email по ссылке из письма.';
  if (m.includes('password should be at least')) return 'Пароль слишком короткий.';
  if (m.includes('anonymous sign-ins are disabled'))
    return 'Гостевой вход выключен в настройках Supabase.';
  return message;
}
