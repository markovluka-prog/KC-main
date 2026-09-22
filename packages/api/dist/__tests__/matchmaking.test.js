import { describe, expect, it } from 'vitest';
import { MatchmakingQueue } from '../lobby/queue.js';
describe('MatchmakingQueue (Phase 4 T4.4)', () => {
    it('pairs first two users in FIFO order', () => {
        const q = new MatchmakingQueue();
        const r1 = q.enqueue('a');
        expect(r1.paired).toBeNull();
        expect(r1.position).toBe(1);
        const r2 = q.enqueue('b');
        expect(r2.paired).toEqual(['a', 'b']);
        expect(q.size()).toBe(0);
    });
    it('re-enqueue moves user to the tail', () => {
        const q = new MatchmakingQueue();
        q.enqueue('a');
        q.enqueue('a');
        expect(q.size()).toBe(1);
    });
    it('leave removes a queued user', () => {
        const q = new MatchmakingQueue();
        q.enqueue('a');
        const removed = q.leave('a');
        expect(removed).toBe(true);
        expect(q.size()).toBe(0);
    });
});
