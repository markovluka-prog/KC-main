// Nickname validation + sanitisation shared by the Settings editor and signup.
// Rules: trim, collapse inner whitespace, cap length, allow letters/digits and a
// few safe punctuation marks, and reject profanity (offline filter). Returns a
// structured result so the UI can show a precise reason.
import { isClean } from './profanity.js';

export const NICK_MAX = 20;
export const NICK_MIN = 2;

export interface NickResult {
  ok: boolean;
  value: string;
  /** i18n message key explaining why it was rejected (empty when ok). */
  reason: string;
}

/** A conservative allow-list: letters (any script), digits, space, _ - . */
const DISALLOWED = /[^\p{L}\p{N} _.-]/gu;

export function sanitizeNickname(raw: string): NickResult {
  const trimmed = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return { ok: false, value: '', reason: 'Введите никнейм.' };

  const stripped = trimmed.replace(DISALLOWED, '');
  if (stripped.length < NICK_MIN) {
    return { ok: false, value: stripped, reason: 'Слишком короткий никнейм.' };
  }
  const value = stripped.slice(0, NICK_MAX);

  if (!isClean(value)) {
    return { ok: false, value: '', reason: 'Никнейм содержит недопустимые слова.' };
  }
  return { ok: true, value, reason: '' };
}

/** Lobby nicknames: English letters/digits only (space _ - .), 2–12 chars, no bad words. */
export const LOBBY_NICK_MAX = 12;
const ENGLISH_ONLY = /^[A-Za-z0-9 _.-]+$/;

export function sanitizeLobbyName(raw: string): NickResult {
  const trimmed = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return { ok: false, value: '', reason: 'Введите никнейм.' };
  if (!ENGLISH_ONLY.test(trimmed)) {
    return { ok: false, value: '', reason: 'Никнейм: только английские буквы и цифры.' };
  }
  if (trimmed.length < NICK_MIN) return { ok: false, value: trimmed, reason: 'Слишком короткий никнейм.' };
  if (trimmed.length > LOBBY_NICK_MAX) return { ok: false, value: trimmed, reason: 'Слишком длинный никнейм.' };
  if (!isClean(trimmed)) return { ok: false, value: '', reason: 'Этот никнейм нельзя использовать.' };
  return { ok: true, value: trimmed, reason: '' };
}
