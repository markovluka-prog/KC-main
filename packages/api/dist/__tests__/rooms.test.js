import { afterEach, describe, expect, it } from 'vitest';
import { _resetRooms, createRoom, deleteRoom, deleteRoomByMatch, getRoom, normaliseCode, } from '../lobby/rooms.js';
afterEach(() => _resetRooms());
describe('room-code registry', () => {
    it('creates a room with a 6-char unambiguous code', () => {
        const r = createRoom('host-1', 'match-1');
        expect(r.code).toHaveLength(6);
        expect(r.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
        expect(r.matchId).toBe('match-1');
        expect(r.hostUserId).toBe('host-1');
    });
    it('looks up a room case-insensitively and ignoring dashes/space', () => {
        const r = createRoom('host-1', 'match-1');
        expect(getRoom(r.code.toLowerCase()).matchId).toBe('match-1');
        expect(getRoom(` ${r.code.slice(0, 3)}-${r.code.slice(3)} `).matchId).toBe('match-1');
    });
    it('returns null for an unknown code', () => {
        expect(getRoom('ZZZZZZ')).toBeNull();
    });
    it('normaliseCode uppercases and strips non-alphanumerics', () => {
        expect(normaliseCode(' ab-cd ef ')).toBe('ABCDEF');
    });
    it('deleteRoom removes a code', () => {
        const r = createRoom('host-1', 'match-1');
        deleteRoom(r.code);
        expect(getRoom(r.code)).toBeNull();
    });
    it('deleteRoomByMatch removes whichever code points at a match', () => {
        const r = createRoom('host-1', 'match-xyz');
        deleteRoomByMatch('match-xyz');
        expect(getRoom(r.code)).toBeNull();
    });
});
