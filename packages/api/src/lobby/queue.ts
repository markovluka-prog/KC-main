/**
 * Phase 4 T4.4 — in-memory FIFO matchmaking. ELO matchmaking is Phase 5+.
 *
 * For MVP we just pair the first two players who enter the queue. ELO
 * deltas don't matter for first-match feel. The queue lives per-instance;
 * on Cloud Run cold-start we persist a snapshot to `match_invites` so
 * partial pairings survive restarts.
 */

export interface QueueEntry {
  userId: string;
  enqueuedAt: number;
}

export class MatchmakingQueue {
  private queue: QueueEntry[] = [];

  enqueue(userId: string): { paired: [string, string] | null; position: number } {
    // Re-enqueue removes the existing slot.
    this.queue = this.queue.filter((q) => q.userId !== userId);
    this.queue.push({ userId, enqueuedAt: Date.now() });
    if (this.queue.length >= 2) {
      const a = this.queue.shift()!;
      const b = this.queue.shift()!;
      return { paired: [a.userId, b.userId], position: 0 };
    }
    return { paired: null, position: this.queue.length };
  }

  leave(userId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.userId !== userId);
    return this.queue.length < before;
  }

  size(): number {
    return this.queue.length;
  }

  snapshot(): readonly QueueEntry[] {
    return this.queue;
  }
}
