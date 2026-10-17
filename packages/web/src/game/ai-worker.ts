/**
 * AI search worker.
 *
 * Runs the MCTS off the main thread so the game keeps rendering at full frame
 * rate while the bot thinks. The previous approach — slicing the search across
 * animation frames — still blocked the main thread for the duration of every
 * slice; on `hard` that is hundreds of consecutive blocking chunks per turn.
 *
 * The search is reused as-is rather than reimplemented: `AIPlayer`'s light-state
 * search touches the live game only through `player1Bottom` and reads the map
 * from the `@kc/game-rules` world module. So the worker installs the layout it
 * was sent, hands `AIPlayer` a stub game, and runs the ordinary synchronous
 * search. There is exactly one search implementation in the codebase.
 */
/// <reference lib="webworker" />
import {
  getAllRuins,
  getTowers,
  setCastleColumns,
  setRuins,
  setRuins2,
  setTerrain,
  setConstructions,
  setTowers,
} from '@kc/game-rules';
import { AIPlayer, type AIGameAPI } from './ai.js';
import type {
  DoneMessage,
  ErrorMessage,
  ProgressMessage,
  SearchRequest,
  WorkerRequest,
  WorkerState,
} from './ai-worker-protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Requests the main thread has cancelled; their replies are never sent. */
const cancelled = new Set<number>();

/** Minimal AIGameAPI. The light-state search reads only `player1Bottom`; the
 *  rest exists to satisfy the interface and is never called during a search. */
function makeWorkerGame(player1Bottom: boolean, maxActivatedPerTurn?: number): AIGameAPI {
  const noop = (): void => {};
  const stub = {
    mode: 'ai' as const,
    // The real game activates at most 3 distinct units per turn. Omitting this
    // made turnActivationCap() return MAX_SAFE_INTEGER inside the worker, so
    // every rollout simulated ten-unit turns that the game would never run —
    // the search was solving a different game from the one on screen.
    maxActivatedPerTurn,
    currentPlayer: 1,
    winner: null,
    selectedUnit: null,
    pendingWeaponEquip: null,
    pendingCastleHealing: null,
    player1Bottom,
    inventory: { 1: {}, 2: {} },
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    lastEvent: '',
    board: {
      units: [],
      unitAt: () => null,
      // Read the REAL layout (installed by handleSearch below). These used to be
      // hardcoded false, which silently disabled every economy action inside the
      // worker: the search generates ruins-searching and tower spells from these
      // predicates, and in the browser the search runs HERE. The bot therefore
      // never farmed ruins or cast a spell in an actual game, however the
      // heuristics were tuned.
      isTower: (row: number, col: number) => getTowers().some((t) => t.row === row && t.col === col),
      // Ruins hold nothing now (artifacts are scattered invisibly board-wide and
      // claimed by walking onto them), so this must match Board.inRuins and
      // report false — otherwise the worker plans ruins-camping turns the real
      // game can no longer honour.
      inRuins: () => false,
    },
    isGameActive: () => true,
    ownUnits: () => [],
    canUnitAct: () => false,
    selectUnit: noop,
    clearHighlights: noop,
    forceEndTurn: noop,
    endTurn: noop,
    shouldEndTurn: () => true,
    weaponEquipTargets: () => [],
    equipPendingWeapon: noop,
    computeDamage: () => 0,
    moveActionsFor: () => [],
    attackActionsFor: () => [],
    performAttack: () => false,
    performMove: () => false,
    drawArtifact: noop,
    castSpell: noop,
    skipSelected: noop,
    canAfford: () => false,
    renderSidebar: noop,
  };
  return stub as unknown as AIGameAPI;
}

function handleSearch(req: SearchRequest): void {
  // The worker has its own module instance of the world layout, so install the
  // caller's map before searching or every geometry heuristic reads defaults.
  setCastleColumns(req.layout.castleP1Col, req.layout.castleP2Col);
  setTowers(req.layout.towers);
  setRuins(req.layout.ruins);
  setRuins2(req.layout.ruins2);
  setTerrain(req.layout.terrain);
  setConstructions(req.layout.constructions ?? []);

  const ai = new AIPlayer(
    makeWorkerGame(req.player1Bottom, req.maxActivatedPerTurn),
    req.player,
  );
  ai.setConfig(req.config);


  const internals = ai as any;
  // Feed the search the transferred position instead of the (empty) stub board.
  // A sender that omits the activation budget (older callers, tests) must not
  // leave the search with zero activations — that silently yields an empty plan.
  const state = structuredClone(req.state);
  if (typeof state.activationsLeft !== 'number') {
    state.activationsLeft = req.maxActivatedPerTurn ?? 3;
  }
  if (!state.inventory) state.inventory = {};
  internals.createLightState = (): WorkerState => structuredClone(state);

  // Drive the search in slices so progress can be reported. Slices no longer
  // exist to keep a UI responsive — the whole worker is off the main thread —
  // they only pace the progress messages.
  internals.mctsBegin();
  for (;;) {
    if (cancelled.has(req.requestId)) {
      cancelled.delete(req.requestId);
      return;
    }
    const done: boolean = internals.mctsSlice(50);
    const progress: ProgressMessage = {
      type: 'progress',
      requestId: req.requestId,
      progress: ai.thinkProgress ?? 0,
    };
    ctx.postMessage(progress);
    if (done) break;
  }
  const plan = internals.mctsFinish();
  // Drop the retained tree: it would pin the whole search tree in memory for the
  // lifetime of the worker, and the main thread starts each request fresh.
  internals.mctsRetained = null;

  const reply: DoneMessage = {
    type: 'done',
    requestId: req.requestId,
    plan,
    stats: ai.lastSearchStats,
  };
  ctx.postMessage(reply);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const req = event.data;
  if (req.type === 'cancel') {
    cancelled.add(req.requestId);
    return;
  }
  try {
    handleSearch(req);
  } catch (err) {
    const reply: ErrorMessage = {
      type: 'error',
      requestId: req.requestId,
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(reply);
  }
};
