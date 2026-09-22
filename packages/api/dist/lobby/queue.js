/**
 * Phase 4 T4.4 — in-memory FIFO matchmaking. ELO matchmaking is Phase 5+.
 *
 * For MVP we just pair the first two players who enter the queue. ELO
 * deltas don't matter for first-match feel. The queue lives per-instance;
 * on Cloud Run cold-start we persist a snapshot to `match_invites` so
 * partial pairings survive restarts.
 */
export class MatchmakingQueue {
    queue = [];
    enqueue(userId) {
        // Re-enqueue removes the existing slot.
        this.queue = this.queue.filter((q) => q.userId !== userId);
        this.queue.push({ userId, enqueuedAt: Date.now() });
        if (this.queue.length >= 2) {
            const a = this.queue.shift();
            const b = this.queue.shift();
            return { paired: [a.userId, b.userId], position: 0 };
        }
        return { paired: null, position: this.queue.length };
    }
    leave(userId) {
        const before = this.queue.length;
        this.queue = this.queue.filter((q) => q.userId !== userId);
        return this.queue.length < before;
    }
    size() {
        return this.queue.length;
    }
    snapshot() {
        return this.queue;
    }
}
