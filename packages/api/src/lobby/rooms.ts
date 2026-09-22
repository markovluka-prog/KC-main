/**
 * Track A (A2) — in-memory room-code registry.
 *
 * A "room" is a short, human-shareable code that maps to a match a host has
 * created and is waiting in. A second player joins by typing the code. Single
 * Cloud Run instance (max-instances=1) so an in-memory Map is sufficient; if we
 * ever scale out this moves to Postgres (see registry.ts notes).
 *
 * Codes use an unambiguous alphabet (no 0/O/1/I) so they're easy to read aloud
 * and type. Rooms expire after ROOM_TTL_MS to avoid leaking stale entries.
 */

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN = 6;
const ROOM_TTL_MS = 15 * 60 * 1000;

export interface RoomRecord {
  code: string;
  matchId: string;
  hostUserId: string;
  createdAt: number;
}

const rooms = new Map<string, RoomRecord>();

function randomCode(): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

/** Normalise user input: uppercase, strip whitespace/dashes. */
export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Create a room for `hostUserId` pointing at `matchId`. Returns the code. */
export function createRoom(hostUserId: string, matchId: string): RoomRecord {
  sweepExpired();
  let code = randomCode();
  // Vanishingly unlikely collision, but guard anyway.
  for (let guard = 0; guard < 10 && rooms.has(code); guard += 1) code = randomCode();
  const record: RoomRecord = { code, matchId, hostUserId, createdAt: Date.now() };
  rooms.set(code, record);
  return record;
}

export function getRoom(code: string): RoomRecord | null {
  sweepExpired();
  return rooms.get(normaliseCode(code)) ?? null;
}

export function deleteRoom(code: string): void {
  rooms.delete(normaliseCode(code));
}

/** Remove the room a given host owns (used when their match ends / is abandoned). */
export function deleteRoomByMatch(matchId: string): void {
  for (const [code, r] of rooms) {
    if (r.matchId === matchId) rooms.delete(code);
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

/** Test-only: clear all rooms. */
export function _resetRooms(): void {
  rooms.clear();
}
