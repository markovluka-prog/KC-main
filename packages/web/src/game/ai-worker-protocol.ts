/**
 * Message protocol shared by the main thread and the AI search worker.
 *
 * The MCTS search is pure with respect to the board: it operates on a
 * LightState (plain units + buff counters) and reads the map layout from the
 * `@kc/game-rules` world module, which is process-global mutable state. A worker
 * has its OWN module instance, so the layout has to be shipped across with each
 * request and applied there before the search starts.
 *
 * Everything in here is structured-cloneable — no class instances, no functions.
 */
import type { Construction, RuinsArea, TerrainCell, TowerPosition } from '@kc/game-rules';
import type { AIConfig } from './ai-config.js';

export type WorkerPlayer = 1 | 2;

/** The slice of world layout the search reads. Mirrors the world.ts getters. */
export interface WorldLayoutSnapshot {
  castleP1Col: number;
  castleP2Col: number;
  towers: TowerPosition[];
  ruins: RuinsArea;
  ruins2: RuinsArea;
  terrain: TerrainCell[];
  /** Unfinished build sites — impassable, so the search must see them. */
  constructions?: Construction[];
}

/** A unit as the light-state search sees it (structurally LightUnit). */
export interface WorkerUnit {
  id: number;
  player: WorkerPlayer;
  type: string;
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
  /** Whether this unit already spent one of the turn's activation slots. The
   *  search needs it to tell "may keep moving" from "would open a new slot". */
  activated?: boolean;
}

export interface WorkerState {
  units: WorkerUnit[];
  shieldTurns: Record<WorkerPlayer, number>;
  damageBuff: Record<WorkerPlayer, number>;
  /** Distinct units the side to move may still activate this turn. Without it
   *  the worker plans turns longer than the game will execute. */
  activationsLeft?: number;
  /** The searching player's artifacts. Required for the search to cost spells
   *  and crafting; an empty inventory makes every such action unaffordable. */
  inventory?: Record<string, number>;
}

/** A single planned action (structurally PlanEntry). */
export interface WorkerPlanEntry {
  unitId: number;
  action: {
    type: string;
    row?: number;
    col?: number;
    targetRow?: number;
    targetCol?: number;
    landingRow?: number;
    landingCol?: number;
    cost?: number;
    score?: number;
    [key: string]: unknown;
  };
}

export interface SearchRequest {
  type: 'search';
  /** Correlates the reply with the request; stale replies are dropped. */
  requestId: number;
  player: WorkerPlayer;
  player1Bottom: boolean;
  config: AIConfig;
  state: WorkerState;
  layout: WorldLayoutSnapshot;
  /** The game's per-turn activation cap (maxActivatedPerTurn, 3 in the real
   *  game). The worker's stub game had no such field, so turnActivationCap()
   *  read undefined and returned MAX_SAFE_INTEGER: every rollout assumed all
   *  ten units could act each turn, while the real game executes three and
   *  silently drops the rest. The search was optimising a game with different
   *  rules from the one being played. */
  maxActivatedPerTurn?: number;
}

/** Cancels an in-flight search (turn ended, game reset, difficulty changed). */
export interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

export type WorkerRequest = SearchRequest | CancelRequest;

export interface ProgressMessage {
  type: 'progress';
  requestId: number;
  progress: number; // 0..1
}

export interface DoneMessage {
  type: 'done';
  requestId: number;
  plan: WorkerPlanEntry[];
  stats: {
    iterations: number;
    reusedVisits: number;
    rootVisits: number;
    rootChildren: number;
    maxDepth: number;
    elapsedMs: number;
    solved: boolean;
  } | null;
}

export interface ErrorMessage {
  type: 'error';
  requestId: number;
  message: string;
}

export type WorkerResponse = ProgressMessage | DoneMessage | ErrorMessage;
