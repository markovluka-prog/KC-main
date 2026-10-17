/**
 * Main-thread half of the AI search worker.
 *
 * Owns the Worker instance, correlates replies with requests, and degrades
 * gracefully: if the environment has no Worker (Node test runs, an old
 * WKWebView) `isSupported()` returns false and callers keep using the existing
 * frame-sliced search. That fallback is deliberate — the worker is a latency
 * optimisation, never a correctness requirement.
 */
import {
  getCastleP1Col,
  getCastleP2Col,
  getRuins,
  getRuins2,
  getTerrain,
  getConstructions,
  getTowers,
} from '@kc/game-rules';
import type { AIConfig } from './ai-config.js';
import type {
  DoneMessage,
  SearchRequest,
  WorkerPlanEntry,
  WorkerPlayer,
  WorkerResponse,
  WorkerState,
  WorldLayoutSnapshot,
} from './ai-worker-protocol.ts';

export interface SearchOutcome {
  plan: WorkerPlanEntry[];
  stats: DoneMessage['stats'];
}

interface Pending {
  resolve: (outcome: SearchOutcome) => void;
  reject: (err: Error) => void;
  onProgress: ((progress: number) => void) | undefined;
}

/** True when this environment can run the search off-thread. */
export function isSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/** Snapshot the process-global map layout so the worker can reproduce it. */
export function captureLayout(): WorldLayoutSnapshot {
  return {
    castleP1Col: getCastleP1Col(),
    castleP2Col: getCastleP2Col(),
    towers: getTowers().map((t) => ({ ...t })),
    ruins: { ...getRuins() },
    ruins2: { ...getRuins2() },
    terrain: getTerrain().map((c) => ({ ...c })),
    constructions: getConstructions().map((c) => ({ ...c })),
  };
}

export class AISearchWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** The request currently being searched, so it can be cancelled. */
  private activeId: number | null = null;

  /** Lazily create the worker; returns null when unsupported or construction
   *  fails (a bad bundle, a CSP that blocks workers). Callers fall back. */
  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (!isSupported()) return null;
    try {
      this.worker = new Worker(new URL('./ai-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
        this.handleMessage(event.data);
      };
      this.worker.onerror = (event: ErrorEvent): void => {
        // A worker-level failure invalidates every in-flight request.
        const err = new Error(event.message || 'AI worker error');
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        this.activeId = null;
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private handleMessage(msg: WorkerResponse): void {
    const entry = this.pending.get(msg.requestId);
    if (!entry) return; // stale reply for a cancelled request
    if (msg.type === 'progress') {
      entry.onProgress?.(msg.progress);
      return;
    }
    this.pending.delete(msg.requestId);
    if (this.activeId === msg.requestId) this.activeId = null;
    if (msg.type === 'error') entry.reject(new Error(msg.message));
    else entry.resolve({ plan: msg.plan, stats: msg.stats });
  }

  /** Run one search off-thread. Rejects if the worker is unavailable, so the
   *  caller can fall back to the synchronous path. */
  search(args: {
    player: WorkerPlayer;
    player1Bottom: boolean;
    config: AIConfig;
    state: WorkerState;
    maxActivatedPerTurn?: number;
    onProgress?: (progress: number) => void;
  }): Promise<SearchOutcome> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error('AI worker unavailable'));

    // Only one search at a time: a new turn supersedes anything still running.
    this.cancelActive();

    const requestId = this.nextId;
    this.nextId += 1;
    const request: SearchRequest = {
      type: 'search',
      requestId,
      player: args.player,
      player1Bottom: args.player1Bottom,
      config: args.config,
      state: args.state,
      layout: captureLayout(),
      maxActivatedPerTurn: args.maxActivatedPerTurn,
    };
    return new Promise<SearchOutcome>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress: args.onProgress });
      this.activeId = requestId;
      worker.postMessage(request);
    });
  }

  /** Abandon the in-flight search (turn ended, reset, difficulty changed). */
  cancelActive(): void {
    if (this.activeId === null) return;
    const id = this.activeId;
    this.activeId = null;
    this.pending.delete(id);
    this.worker?.postMessage({ type: 'cancel', requestId: id });
  }

  /** Tear the worker down entirely. */
  dispose(): void {
    this.cancelActive();
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
