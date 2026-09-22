/*
 * Headless MCTS harness.
 *
 * The whole light-state search path (generateActionsForLightState,
 * scoreLightActions, completeTurnGreedy, evaluateLightState, applyEndOfTurn and
 * the MCTS itself) reads board geometry from module constants and touches the
 * live game only for `player1Bottom`. That makes it drivable from Node with a
 * near-empty AIGameAPI stub, which is what both the regression tests and the
 * A/B bench in scripts/ai-bench.ts use.
 *
 * Everything here pokes at private methods through `as any`. That is deliberate
 * and matches the existing convention in ai-search.test.ts: exporting the search
 * internals purely for tests would widen the public surface for no benefit.
 */
import { getAllRuins, getTowers } from '@kc/game-rules';
import { AIPlayer, type AIGameAPI } from '../ai.js';
import type { AIConfig } from '../ai-config.js';

export type Player = 1 | 2;

export interface HarnessUnit {
  id: number;
  player: Player;
  type: 'knight' | 'archer' | 'cavalry' | 'crossbow' | 'catapult';
  row: number;
  col: number;
  hp: number;
  armor: number;
  damage: number;
  maxMoves: number;
  movesLeft: number;
  done: boolean;
  maxHp: number;
  maxArmor: number;
  activated: boolean;
}

export interface HarnessState {
  units: HarnessUnit[];
  shieldTurns: Record<Player, number>;
  damageBuff: Record<Player, number>;
  /** Distinct units the side to move may still activate (see LightState). */
  activationsLeft: number;
  /** The searching player's artifacts (see LightState.inventory). */
  inventory: Record<string, number>;
}

/** Minimal AIGameAPI stub. `player1Bottom` is the only field the light-state
 *  search actually reads; the rest exists to satisfy the interface. */
export function makeHeadlessGame(
  player1Bottom = true,
  maxActivatedPerTurn?: number,
): AIGameAPI {
  const noop = (): void => {};
  const stub = {
    mode: 'ai' as const,
    // The real game caps this at 3. Left undefined by default so existing tests
    // keep measuring pure search behaviour, but the bench/strength tests must
    // pass 3 or they simulate a game nobody is playing.
    maxActivatedPerTurn,
    currentPlayer: 1 as Player,
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
      // Use the real world layout so the search can generate tower spells and
      // ruins searches in tests, exactly as it does in a live game.
      isTower: (row: number, col: number) => getTowers().some((t) => t.row === row && t.col === col),
      inRuins: (row: number, col: number) =>
        getAllRuins().some(
          (r) => row >= r.top && row < r.top + r.height && col >= r.left && col < r.left + r.width,
        ),
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

export function makeUnit(
  overrides: Partial<HarnessUnit> & Pick<HarnessUnit, 'id' | 'player'>,
): HarnessUnit {
  const maxMoves = overrides.maxMoves ?? 2;
  return {
    type: 'knight',
    row: 0,
    col: 0,
    hp: 3,
    armor: 1,
    damage: 2,
    maxMoves,
    movesLeft: maxMoves,
    done: false,
    activated: false,
    maxHp: overrides.hp ?? 3,
    maxArmor: overrides.armor ?? 1,
    ...overrides,
  };
}

export function makeState(
  units: HarnessUnit[],
  activationsLeft = Number.MAX_SAFE_INTEGER,
  inventory: Record<string, number> = {},
): HarnessState {
  return {
    units,
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    // Unlimited by default so existing tests measure search behaviour, not the
    // activation cap; pass a number to exercise the cap explicitly.
    activationsLeft,
    // Empty by default: with no artifacts the search generates no spell/craft
    // actions, so existing tests keep measuring pure tactics.
    inventory,
  };
}

 
type Internals = any;

/** Build an AIPlayer whose search runs against `state` instead of a live board. */
export function makeSearcher(
  player: Player,
  config: Partial<AIConfig>,
  state: HarnessState,
  player1Bottom = true,
  maxActivatedPerTurn?: number,
): AIPlayer {
  const ai = new AIPlayer(makeHeadlessGame(player1Bottom, maxActivatedPerTurn), player, 'hard');
  ai.setConfig(config as Partial<AIConfig> & { label?: string });
  // createLightState() reads the live board; for the harness we inject the
  // position directly so the search starts exactly where the caller wants.
  (ai as Internals).createLightState = () => cloneState(state);
  return ai;
}

export function cloneState(state: HarnessState): HarnessState {
  return {
    units: state.units.map((u) => ({ ...u })),
    shieldTurns: { ...state.shieldTurns },
    damageBuff: { ...state.damageBuff },
    activationsLeft: state.activationsLeft,
    inventory: { ...state.inventory },
  };
}

export interface SearchResult {
  plan: Array<{ unitId: number; action: { type: string; row?: number; col?: number; targetRow?: number; targetCol?: number } }>;
  stats: NonNullable<AIPlayer['lastSearchStats']>;
}

/** Run one full synchronous MCTS think from `state` and return plan + stats. */
export function search(ai: AIPlayer, state: HarnessState): SearchResult {
  (ai as Internals).createLightState = () => cloneState(state);
  const plan = (ai as Internals).mctsSearch();
  return { plan, stats: ai.lastSearchStats! };
}

/** Play a full turn greedily — used by the bench to advance the game between
 *  searched turns and by regression tests that need a follow-up position. */
export function applyPlan(
  ai: AIPlayer,
  state: HarnessState,
  player: Player,
  plan: SearchResult['plan'],
): HarnessState {
  let cur = cloneState(state);
  // Honour the activation cap the way the real game does: it activates at most
  // `activationsLeft` DISTINCT units per turn and refuses everything after that.
  // Executing the whole plan regardless (the old behaviour) made every test
  // measure a turn the game would never actually run.
  const budget = state.activationsLeft ?? Number.MAX_SAFE_INTEGER;
  const activated = new Set<number>();
  for (const entry of plan) {
    if (!activated.has(entry.unitId)) {
      if (activated.size >= budget) continue;
      activated.add(entry.unitId);
    }
    cur = (ai as Internals).applyActionToState(cur, entry.unitId, entry.action);
  }
  return (ai as Internals).applyEndOfTurn(cur, player);
}

export function evaluate(ai: AIPlayer, state: HarnessState, perspective: Player): number {
  return (ai as Internals).evaluateLightState(state, perspective);
}

export function aliveCount(state: HarnessState, player: Player): number {
  return state.units.filter((u) => u.player === player && u.hp > 0).length;
}

/** Outcome of a single headless game between two configs. */
export interface GameResult {
  winner: Player | null; // null = draw / turn limit
  turns: number;
  statsByPlayer: Record<Player, { iterations: number; maxDepth: number; ms: number }[]>;
}

/**
 * Play one full headless game, `p1Config` vs `p2Config`, from `start`.
 * Terminates on wipeout, undefended castle entry, or `maxTurns`.
 */
export function playGame(
  start: HarnessState,
  p1Config: Partial<AIConfig>,
  p2Config: Partial<AIConfig>,
  maxTurns = 60,
  player1Bottom = true,
): GameResult {
  const ais: Record<Player, AIPlayer> = {
    1: makeSearcher(1, p1Config, start, player1Bottom),
    2: makeSearcher(2, p2Config, start, player1Bottom),
  };
  const statsByPlayer: GameResult['statsByPlayer'] = { 1: [], 2: [] };
  let state = cloneState(start);
  let player: Player = 1;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (aliveCount(state, 1) === 0) return { winner: 2, turns: turn, statsByPlayer };
    if (aliveCount(state, 2) === 0) return { winner: 1, turns: turn, statsByPlayer };

    const ai = ais[player];
    const { plan, stats } = search(ai, state);
    statsByPlayer[player].push({
      iterations: stats.iterations,
      maxDepth: stats.maxDepth,
      ms: stats.elapsedMs,
    });
    if (plan.length === 0) {
      // No legal plan — pass the turn rather than deadlocking.
      state = (ai as Internals).applyEndOfTurn(state, player);
    } else {
      state = applyPlan(ai, state, player, plan);
    }

    // Castle capture: the real win condition the rollouts optimise for.
    const opp: Player = player === 1 ? 2 : 1;
    const inCastle = state.units.some(
      (u) => u.player === player && u.hp > 0 && (ai as Internals).inCastleZone(u.row, u.col, opp),
    );
    const defended = state.units.some(
      (u) => u.player === opp && u.hp > 0 && (ai as Internals).inCastleZone(u.row, u.col, opp),
    );
    if (inCastle && !defended) return { winner: player, turns: turn + 1, statsByPlayer };

    player = opp;
  }
  return { winner: null, turns: maxTurns, statsByPlayer };
}

