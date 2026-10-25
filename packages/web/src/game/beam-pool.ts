/**
 * Runs the beam/rollout AI on a pool of Web Workers (beam-worker.ts), one
 * slice of the candidate plans per worker, so the search uses every core and
 * never blocks the page. The merged result is identical to calling
 * planTurnFor on the main thread (see planTurnSliceFor / mergeRolloutPicks).
 */
import {
  isTwoPass,
  mergeRolloutPicks,
  selectFinalists,
  type FirstPassScore,
  type AIWeights,
  type BeamDifficultyConfig,
  type GameState,
  type Player,
  type RolloutPick,
  type ServerAction,
} from '@kc/game-rules';

let pool: Worker[] | null = null;
let nextId = 1;

function workers(): Worker[] {
  if (!pool) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    const n = Math.max(1, Math.min(8, cores - 1));
    pool = Array.from({ length: n }, () => new Worker(new URL('./beam-worker.ts', import.meta.url), { type: 'module' }));
  }
  return pool;
}

export function beamPoolSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/** Ask worker `w` for one slice; resolves with its reply payload. */
function ask<T>(w: Worker, req: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const onMessage = (e: MessageEvent<{ id: number } & T>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      resolve(e.data);
    };
    const onError = (err: ErrorEvent) => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      reject(err);
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ id, ...req });
  });
}

/** Plan `me`'s turn off the main thread. `onProgress` gets 0..1 as slices finish. */
export async function planTurnInPool(
  state: GameState,
  me: Player,
  config: BeamDifficultyConfig,
  seed: number,
  weights: AIWeights | undefined,
  onProgress?: (p: number) => void,
): Promise<ServerAction[]> {
  const ws = workers();
  const slices = config.rollout ? ws.length : 1;
  const base = { state, me, config, seed, weights, slices };
  // Halving presets: pass 1 scores every candidate once, pass 2 finishes the
  // best few — the same result as the sequential planTurnFor.
  const passes = isTwoPass(config) ? 2 : 1;
  let done = 0;
  const tick = () => onProgress?.(++done / (slices * passes));

  let finalists: FirstPassScore[] | undefined;
  if (passes === 2) {
    const firsts = await Promise.all(
      ws.slice(0, slices).map((w, k) =>
        ask<{ scores: FirstPassScore[] }>(w, { ...base, slice: k, pass: 'first' }).then((r) => (tick(), r.scores)),
      ),
    );
    finalists = selectFinalists(firsts.flat(), config.rollout!.finalists!);
  }
  const picks = await Promise.all(
    ws.slice(0, slices).map((w, k) =>
      ask<{ pick: RolloutPick }>(w, { ...base, slice: k, ...(finalists ? { pass: 'final', finalists } : {}) }).then(
        (r) => (tick(), r.pick),
      ),
    ),
  );
  return mergeRolloutPicks(picks).actions;
}
