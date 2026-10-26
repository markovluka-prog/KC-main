import {
  type AttackAction,
  type GearItem,
  type MoveAction,
  type Player,
  type CraftRecipe,
  type PartName,
  type UnitTypeKey,
  WEAPONS,
  ARMORS,
  ARCHER_SQUARE_RADIUS,
  CATAPULT_MIN_RANGE,
  CATAPULT_MAX_RANGE,
  ROWS,
  COLS,
  getCastleP1Col,
  getCastleP2Col,
  getAllRuins,
  getTowers,
  getTerrain,
  getConstructions,
  emptyBackpack,
  insideBoard,
  manhattan,
  BEAM_DIFFICULTY,
  CROSSBOW_PIERCE_COST,
  CROSSBOW_PIERCE_RANGE,
  CAVALRY_RIVER_JUMP_COST,
  MAGE_ENERGY_REGEN_PER_TURN,
  MAGE_MAX_ENERGY,
  TOWER_DAMAGE_FACTOR,
  archerRadiusFor,
  catapultMaxRangeFor,
} from '@kc/game-rules';
import type { RuinsArea } from '@kc/game-rules';
// Common spells (Дождь защиты/Сталь свободы/Небо огня) were removed from the
// game entirely — only the mage's own 4 abilities exist now (attack/ward/
// drain/burn-bridge/heal — see @kc/game-rules' apply.ts mage-* actions). The
// AI never learned about those (out of scope for this change), so every
// SPELLS reference below is dead code kept alive as an empty list rather than
// rewritten, since the AI's spell-casting behaviour isn't part of this work.
const SPELLS: readonly { name: string; recipe: CraftRecipe; desc: string; icon: string }[] = [];
type ArtifactName = PartName;
type SpellRecipe = CraftRecipe;
import type { Board } from './Board.js';
import type { Unit, UnitWeapon } from './Unit.js';
import { AI_DIFFICULTY, type AIConfig, type AIDifficulty } from './ai-config.js';
import RAW_WEIGHTS from './ai-weights.json';
import { AISearchWorker, isSupported as isWorkerSupported } from './ai-worker-client.js';
import type { WorkerState } from './ai-worker-protocol.ts';
import { beamPlanFor, snapshotGameState, toPlanEntry } from './beam-bridge.js';
import { beamPoolSupported, planTurnInPool } from './beam-pool.js';
import { applyAction as rulesApply, generateActionsForPlayer, mulberry32 as rulesRng, applyFacingDamage, baseWeightsFor, facingOf, facingToward, scaleWeights, turnCost, winChance, type Facing, type ServerAction, type GameState } from '@kc/game-rules';
import {
  assignRoles,
  isPersonality,
  PERSONALITIES,
  type Personality,
  deriveWorldState,
  planStep,
  selectGoal,
  type ForceRatioBucket,
  type WorldState,
} from './goap.js';
import { NNEvaluator, softmax } from './nn-eval.js';
import type { BoardOrientation } from './nn-features.js';

/**
 * Evaluation weights, loaded from ai-weights.json.
 *
 * Every magic number that evaluateLightState used to carry inline now lives in
 * that file on ONE stated scale (a unit ≈ 10000), so the terms can be compared
 * and tuned instead of accumulating independently. `$comment` keys are
 * documentation and are ignored here.
 */
const W = RAW_WEIGHTS as unknown as AIWeights;

interface AIWeights {
  material: {
    presence: number;
    perHp: number;
    perArmor: number;
    perDamage: number;
    byType: Record<string, number>;
    onTower: number;
    wipeout: number;
  };
  castle: {
    captureUndefended: number;
    captureDefended: number;
    lossUndefended: number;
    lossDefended: number;
    raidThreatRadius: number;
    raidThreatPerCell: number;
    approachPerCell: number;
  };
  focus: { woundedEnemyMax: number };
  retreat: {
    outnumberedHomePerCell: number;
    outnumberedHomeRadius: number;
    lowHpThreshold: number;
    lowHpDistBonusPerCell: number;
    lowHpDistBonusMax: number;
  };
  spacing: {
    rangedAdjacentPenalty: number;
    rangedOptimalBonus: number;
    rangedNearBonus: number;
    catapultTooCloseWithinPenalty: number;
    catapultOptimalBonus: number;
    meleeCloseBonus: number;
    meleeNearBonus: number;
  };
  threat: {
    perDamagePoint: number;
    victimValueFraction: number;
    hangingBase: number;
    hangingValueFraction: number;
    hangingMax: number;
    heavilyThreatenedRatio: number;
    heavilyThreatenedPenalty: number;
  };
  cohesion: { isolatedPenalty: number; radius: number };
  economy: {
    artifactBase: number;
    artifactByName: Record<string, number>;
    completeRecipeBonus: number;
    ruinsControlBonus: number;
    ruinsApproachPerCell: number;
    ruinsApproachRadius: number;
    unequippedWeaponValue: number;
    unequippedArmorValue: number;
  };
  buffs: { shieldPerTurn: number; damageBuffPerTurn: number };
  rollout: {
    opponentNoiseChance: number;
    opponentNoiseTopK: number;
    terminalDiscount: number;
    staticEvalScale: number;
  };
}

/**
 * Sub-set of the main game class that the AI driver needs. Defined as an
 * interface so this module can stay decoupled from the giant
 * KnightsAndCastlesGame class. The real game class implements it (TS will
 * catch drift).
 */
export interface AIGameAPI {
  readonly mode: 'pvp' | 'ai' | 'story';
  readonly currentPlayer: Player;
  readonly winner: Player | null;
  readonly player1Bottom: boolean;
  /** How many DISTINCT units may still be activated this turn. The game caps
   *  this (maxActivatedPerTurn, 3 by default); a unit is charged the first time
   *  it is selected. The search must respect it, or it plans turns the game
   *  will refuse to execute. Optional so older AIGameAPI stubs still typecheck. */
  readonly activatedCount?: number;
  /** Live turn counter (1 on the first turn; +1 per end-turn). */
  readonly turnNumber?: number;
  readonly maxActivatedPerTurn?: number;
  readonly board: Board;
  selectedUnit: Unit | null;
  pendingWeaponEquip: PendingWeaponEquip | null;
  pendingCastleHealing: PendingCastleHealing | null;
  /** Legacy shared per-player pool. The live game no longer has one — parts
   *  live in each unit's own backpack — so this is optional and only read
   *  through sideParts(). */
  readonly inventory?: Record<Player, Partial<Record<ArtifactName, number>>>;
  readonly shieldTurns: Record<Player, number>;
  readonly damageBuff: Record<Player, number>;
  lastEvent: string;

  isGameActive(): boolean;
  ownUnits(player: Player): Unit[];
  canUnitAct(unit: Unit): boolean;
  selectUnit(row: number, col: number, byAi?: boolean): void;
  clearHighlights(): void;
  forceEndTurn(): void;
  endTurn(): void;
  shouldEndTurn(): boolean;
  weaponEquipTargets(equip: PendingWeaponEquip): Unit[];
  equipPendingWeapon(unitId: number): void;
  computeDamage(attacker: Unit, target: Unit): number;
  moveActionsFor(unit: Unit): MoveAction[];
  attackActionsFor(unit: Unit | UnitLikeForAttack): AttackAction[];
  performAttack(row: number, col: number, byAi?: boolean, chosenAction?: AttackAction | null): boolean;
  performMove(row: number, col: number, byAi?: boolean): boolean;
  drawArtifact(byAi?: boolean): void;
  castSpell(index: number, byAi?: boolean): void;
  craftWeapon(index: number, byAi?: boolean): boolean;
  craftArmor(index: number, byAi?: boolean): boolean;
  applyCastleHealing(): void;
  /** Execute a mage ability / build action for the selected unit (rows in
   *  live orientation). Optional: headless stubs don't implement it. */
  performEngineAction?(action: ServerAction): boolean;
  isUnitInOwnCastle(unit: Unit): boolean;
  skipSelected(byAi?: boolean): void;
  canAfford(inv: Record<ArtifactName, number>, recipe: SpellRecipe): boolean;
  canEquipWeaponToUnit(
    equip: {
      slot?: string;
      allowedTypes?: UnitTypeKey[] | null;
      forbidTypes?: UnitTypeKey[] | null;
      archerOnly?: boolean;
    },
    unit: Unit,
  ): boolean;
  canEquipGearForPickup(item: GearItem & { slot: 'weapon' | 'armor' }, unit: Unit): boolean;
  /** Dead units' backpacks lying on the board (parts + weapon + armour). */
  readonly droppedBackpacks?: Array<{
    row: number;
    col: number;
    parts: Partial<Record<ArtifactName, number>>;
    weapon: (GearItem & { slot?: 'weapon' | 'armor' }) | null;
    armorGear: (GearItem & { slot?: 'weapon' | 'armor' }) | null;
  }>;
  renderSidebar(): void;
}

interface UnitLikeForAttack {
  type: UnitTypeKey;
  player: Player;
  row: number;
  col: number;
  movesLeft: number;
}

export interface PendingWeaponEquip {
  name: string;
  amount: number;
  icon: string;
  allowedTypes: UnitTypeKey[] | null;
  forbidTypes: UnitTypeKey[] | null;
  archerOnly: boolean;
  slot?: string;
}

export interface PendingCastleHealing {
  unitId: number;
  needsHp?: boolean;
  needsArmor?: boolean;
}

export type AIActionType =
  | 'attack'
  | 'move'
  | 'draw'
  | 'spell'
  | 'craft'
  | 'craft-armor'
  | 'castle-heal'
  | 'skip'
  // A canonical-engine action the live game executes through
  // AIGameAPI.performEngineAction (mage abilities, building) — see beam-bridge.
  | 'engine';

// ── Scenario strategy (replaces the old Q-learning brain) ────────────────────
// The AI reads the board once per turn and decides which STAGE of a deliberate
// game-plan it's in, then biases unit scoring toward that stage's intent. This
// is a debuggable script, not a learned table. The stages follow the plan:
//
//   sally    – (1) get ~3/4 of the army out of our own castle. Don't sit home.
//   take-ruins – (2) capture the ruins so we own the economy.
//   hold-bridge – (3) plant a unit on the bridge (the only river crossing) to
//                 wall off the enemy, WITHOUT abandoning the ruins.
//   arm-up   – (4)(7) farm artifacts in the ruins, craft weapons/armor, and
//              prefer fighting with armed units. Hold the bridge meanwhile.
//   march    – (6) leave ONE guard in the ruins; move the squad across the
//              bridge toward the enemy castle.
//   assault  – (8)(9) push into the enemy castle, dragging the fight inside; if
//              the enemy stood to fight, feed reinforcements over the bridge.
//   mop-up   – (10) kill every enemy unit inside the castle to win/secure it.
//   defend   – fallback: our own castle is threatened and we're not ahead.
export type StrategyStage =
  | 'sally'
  | 'take-ruins'
  | 'hold-bridge'
  | 'arm-up'
  | 'march'
  | 'assault'
  | 'mop-up'
  | 'defend'
  | 'hunt'; // berserker personality only: chase the nearest enemy unit

interface Strategy {
  stage: StrategyStage;
  // Primary cell the squad should gravitate toward this turn. Canonical
  // orientation (P1 top).
  goalRow: number;
  goalCol: number;
  // How strongly to pull units toward the goal, 0..1 (scaled by strategyWeight).
  pull: number;
  // Cell a single unit should sit on and hold (bridge chokepoint, ruins guard),
  // or null. The CLOSEST eligible unit is rewarded for occupying/staying on it.
  holdRow: number | null;
  holdCol: number | null;
  // When true, prefer keeping at least one unit parked in the ruins (don't strip
  // the economy bare on the march).
  keepRuinsGuard: boolean;
  // How many units should STAY in the ruins and level up (draw artifacts) instead
  // of advancing. 0 = nobody farms. When >0, the closest N units to the ruins are
  // held there searching, and the bridge becomes a knights+archers objective.
  ruinsFarmers: number;
}

export interface AIAction {
  type: AIActionType;
  row?: number;
  col?: number;
  targetRow?: number;
  targetCol?: number;
  landingRow?: number;
  landingCol?: number;
  index?: number;
  cost?: number;
  score: number;
  /** Crossbow pierce only: every cell the bolt flies through, in order. The
   *  game keys the shot by the FIRST cell; targetRow/Col names the first
   *  enemy on the line so the scorers can price the hit. */
  pierce?: Array<{ row: number; col: number }>;
  /** type 'engine' only: the ServerAction, rows already in live orientation. */
  server?: ServerAction;
}

interface PlanEntry {
  unitId: number;
  action: AIAction;
}

interface LightUnit {
  id: number;
  player: Player;
  type: UnitTypeKey;
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
  /** True once this unit has spent one of the turn's activation slots. Acting
   *  with it again is free; acting with a fresh unit costs a slot. */
  activated: boolean;
  /** Id of the mage shielding this unit (a hit is absorbed into its energy). */
  wardedBy?: number | null;
  /** Mage only: energy left to pay for absorbed hits. */
  energy?: number;
  /** Which way it looks (facing.ts) — turning costs a move, the back takes ×2. */
  facing?: Facing;
}

interface LightState {
  units: LightUnit[];
  shieldTurns: Record<Player, number>;
  damageBuff: Record<Player, number>;
  /** Distinct units the side to move may still activate this turn. The game
   *  enforces this cap (maxActivatedPerTurn); without it in the light state the
   *  search happily plans 6-unit turns that the game then refuses to run,
   *  silently dropping every entry past the third — which looks exactly like a
   *  bot standing still doing nothing. */
  activationsLeft: number;
  /** Artifact counts for the searching player only. Needed so the search can
   *  cost spells and crafting: without it, casting was invisible to MCTS and
   *  `hard` (trustSearch) never spent a single artifact. Only the AI's own
   *  inventory is modelled — the opponent's is not observable here. */
  inventory: Partial<Record<ArtifactName, number>>;
}

interface Threat {
  enemy: Unit;
  target: Unit;
  damage: number;
  lethal: boolean;
  priority: number;
}

interface ComboAttacker {
  unit: Unit;
  damage: number;
  attacks: AttackAction[];
}

interface Combo {
  target: Unit;
  attackers: ComboAttacker[];
  totalDamage: number;
  targetValue: number;
}

interface UnitPriority {
  unit: Unit;
  action: AIAction | null;
  priority: number;
}

interface PositionEval {
  totalScore: number;
  materialScore: number;
  positionScore: number;
  threatScore: number;
  controlScore: number;
}

function otherPlayer(player: Player): Player {
  return player === 1 ? 2 : 1;
}

/** A candidate first action for a turn-plan, scored once and expanded lazily.
 *  Progressive Widening turns these into children one at a time, so a rarely
 *  visited node never pays for plans it will not explore. */
interface PlanStarter {
  unitId: number;
  action: AIAction;
  score: number;
}

interface MCTSNode {
  state: LightState;
  player: Player; // whose turn it is at this node (they haven't moved yet)
  parent: MCTSNode | null;
  parentPlan: PlanEntry[]; // the plan that produced this state from the parent
  children: MCTSNode[];
  visits: number;
  totalValue: number; // sum of rollout outcomes, always from ownPerspective
  // Cached minimax-aware value from ownPerspective (see refreshValue). Kept up
  // to date bottom-up in backprop so selection never has to walk the subtree.
  value: number;
  // ---- Terminal-state cache. Computed once when the node is created instead of
  // re-filtering the unit array on every descent through mctsSelect.
  terminal: boolean;
  terminalValue: number; // only meaningful when terminal === true
  // ---- MCTS-Solver. Once a node is proven win/loss, the search stops spending
  // rollouts on it and the proof propagates toward the root.
  solved: boolean;
  solvedValue: number; // +1 = proven win for ownPerspective, -1 = proven loss
  // ---- Lazy / Progressive Widening expansion state.
  // null = starters not computed yet. Each expansion consumes one starter.
  starters: PlanStarter[] | null;
  starterIndex: number; // next starter to turn into a child
  greedyTried: boolean; // the unseeded fully-greedy plan is always tried first
  seenSignatures: Set<string>; // dedupes plans that collapse to the same actions
  // ---- RAVE / AMAF statistics, keyed by action signature. Shared across all
  // children of this node: "how well did this action do anywhere below here".
  amaf: Map<string, { visits: number; value: number }> | null;
  // Action signatures contained in this node's own parentPlan, precomputed so
  // backprop does not re-derive them on every visit.
  planActionKeys: string[];
}

function keyOf(row: number, col: number): string {
  return row + ',' + col;
}

export class AIPlayer {
  private readonly game: AIGameAPI;
  readonly player: Player;
  private difficulty: AIDifficulty | string;
  private config: AIConfig;
  private frameWait: number;
  private frameCounter = 0;
  private readonly strategyCache = new Map<string, unknown>();
  private turnPlan: PlanEntry[] | null = null;
  private focusTarget: number | null = null;
  // Strategic plan for the current turn: a game PHASE + GOAL the planner derives
  // once per turn (see computeStrategy). Replaces the old learned Q-brain, which
  // never actually learned. Recomputed lazily at the start of each turn.
  private strategy: Strategy | null = null;
  // Watchdog state: detect a turn that makes no measurable progress so the
  // bot can never freeze the game (замечание №4 «Он завис и не ходит»).
  private watchdogSig = '';
  private watchdogStall = 0;

  // ── Time-sliced MCTS "thinking" progress ──────────────────────────────────
  // The search runs in small slices across animation frames so the screen never
  // freezes and a real progress bar can animate. thinkProgress is 0..1 (or null
  // when not thinking) — the UI reads it to draw the bar.
  thinkProgress: number | null = null;
  private mctsRoot: MCTSNode | null = null; // persists across slices of one turn
  private mctsDeadline = 0; // wall-clock end of the current think
  private mctsBudgetMs = 0; // total budget for this think (for progress %)
  private static readonly WATCHDOG_MAX_STALL = 40;
  // Target wall-clock cost of one un-interrupted batch of iterations. Small
  // enough that overshooting it cannot drop a frame, large enough that now()
  // is not called on every single iteration.
  private static readonly BATCH_TARGET_MS = 4;
  // See AIConfig.raveBias: tuned upward from the Go-literature default because
  // this game's plans are order-dependent and a slow AMAF decay hides tactics.
  private static readonly DEFAULT_RAVE_BIAS = 0.05;
  // Rolling estimate of one iteration's cost, used to size the batch. Seeded
  // pessimistically so the very first batch is a single iteration.
  private mctsIterCostMs = 4;
  // The finished tree from the previous turn, kept so the next think can re-root
  // into it instead of searching the same position from scratch (tree reuse).
  private mctsRetained: MCTSNode | null = null;
  // ── Off-thread search state ───────────────────────────────────────────────
  private searchWorker: AISearchWorker | null = null;
  private workerBusy = false; // a search is in flight
  private workerPlan: PlanEntry[] | null = null; // result waiting to be consumed
  // ── Search instrumentation (read by the bench harness and ?aidebug=1) ──────
  private mctsIterations = 0;
  private mctsReusedNodes = 0;
  /** Per-turn search statistics for the last completed think. */
  lastSearchStats: {
    iterations: number;
    reusedVisits: number;
    rootVisits: number;
    rootChildren: number;
    maxDepth: number;
    elapsedMs: number;
    solved: boolean;
  } | null = null;

  // ── Learned policy/value network (see ai-config.ts's useNeuralNet) ─────────
  // Null until setNNEvaluator() is called with a loaded net. Every read site
  // checks both config.useNeuralNet AND this being non-null, so a preset that
  // opts in before a net exists (or before this AIPlayer's owner bothers
  // loading one) just falls through to the original heuristic path untouched.
  private nnEvaluator: NNEvaluator | null = null;

  constructor(game: AIGameAPI, player: Player, difficulty: AIDifficulty = 'medium') {
    this.game = game;
    this.player = player;
    this.difficulty = difficulty;
    this.config = AI_DIFFICULTY[difficulty] ?? AI_DIFFICULTY.medium;
    this.frameWait = this.config.frameWait;
  }

  /** Inject (or clear, with null) a loaded policy/value network. Has no effect
   *  unless config.useNeuralNet is also true — see that field's doc comment. */
  setNNEvaluator(evaluator: NNEvaluator | null): void {
    this.nnEvaluator = evaluator;
  }

  private get nnActive(): boolean {
    return Boolean(this.config.useNeuralNet && this.nnEvaluator);
  }

  /** THE intelligence dial (config.intelligence, default 1). Everything the
   *  search budgets read is multiplied/scaled by this, so one number turns the
   *  bot's thinking up arbitrarily high. Clamped ≥ 1. */
  private get iq(): number {
    return Math.max(1, this.config.intelligence ?? 1);
  }

  /** Search time/node budgets scale LINEARLY with iq — 1000× iq = 1000× thinking
   *  time. (The user asked for "max strength, time doesn't matter".) */
  private scaleBudget(base: number): number {
    return Math.round(base * this.iq);
  }

  /** Depth/breadth scale SUB-linearly (√iq) — search cost is exponential in
   *  depth and polynomial in breadth, so a linear scale would hang forever and
   *  add nothing past a point. √iq still grows them a lot (iq 1e6 → ×1000) while
   *  staying tractable, and the linear time/node budget above is the real lever. */
  private scaleSearch(base: number): number {
    return Math.max(base, Math.round(base * Math.sqrt(this.iq)));
  }

  setDifficulty(difficulty: AIDifficulty | string): void {
    this.difficulty = difficulty;
    // "<difficulty>@<personality>" (e.g. "hard@berserker") picks a GOAP
    // personality on top of the difficulty — see goap.ts PERSONALITIES.
    const [base, persona] = String(difficulty).split('@');
    this.personality = isPersonality(persona) ? persona : 'strategist';
    difficulty = base as AIDifficulty;
    // "chance:NN" — the target-probability AI (see chanceStep): NN = the AI's
    // own win chance it steers towards, in percent.
    const m = /^chance:(\d+(?:\.\d+)?)$/.exec(String(difficulty));
    this.chanceTarget = m ? Math.max(0, Math.min(100, Number(m[1]))) / 100 : null;
    this.config = AI_DIFFICULTY[difficulty as AIDifficulty] ?? AI_DIFFICULTY.medium;
    this.frameWait = this.config.frameWait;
    this.reset();
  }

  setConfig(config: Partial<AIConfig> & { label?: string }): void {
    this.difficulty = config.label ?? 'custom';
    this.chanceTarget = null;
    this.personality = 'strategist';
    // Story presets (main.ts) predate the intelligence/strategy knobs and don't
    // set them. Merging over `medium` would silently inherit medium's tuning and
    // make an early "Новичок" fight as hard as a mid-game one, so the strength
    // knobs default from the preset's OWN search budget instead of from medium.
    const merged = { ...AI_DIFFICULTY.medium, ...config };
    const iq = config.intelligence ?? AIPlayer.presetIntelligence(merged);
    merged.intelligence = iq;
    if (config.strategyWeight === undefined) {
      // Weak presets lean on the scenario script; strong ones need less of it.
      merged.strategyWeight = iq >= 4 ? 2.0 : 1.2;
    }
    if (config.trustSearch === undefined) {
      // Only a genuinely deep search is trustworthy enough to skip the overlay.
      merged.trustSearch = iq >= 6;
    }
    this.config = merged;
    this.frameWait = this.config.frameWait;
    this.reset();
  }

  /** Infer an intelligence multiplier for a preset that predates the dial, from
   *  how much search it already asks for. Keeps the story curve monotonic: a
   *  "Новичок" preset stays weak, a "Мастер" preset gets real thinking time. */
  private static presetIntelligence(config: AIConfig): number {
    const budget = config.useMCTS ? config.mctsTimeBudgetMs : config.searchTimeBudgetMs;
    if (budget >= 800) return 6; // Мастер
    if (budget >= 450) return 4; // Тактик
    if (budget >= 280) return 2; // Воин
    return 1; // Ученик / Новичок — stay beatable
  }

  /** True if (row,col) lies inside a ruins rectangle. */
  private inRuins(row: number, col: number): boolean {
    for (const r of getAllRuins()) {
      if (row >= r.top && row < r.top + r.height && col >= r.left && col < r.left + r.width) {
        return true;
      }
    }
    return false;
  }

  /** Centre cell of the ruins area closest to a reference cell (or null if no
   *  ruins on this map). Used as the economy/guard anchor. */
  private nearestRuinsCentre(fromRow: number, fromCol: number): { row: number; col: number } | null {
    let best: { row: number; col: number } | null = null;
    let bestD = Infinity;
    for (const r of getAllRuins()) {
      const c = { row: r.top + Math.floor(r.height / 2), col: r.left + Math.floor(r.width / 2) };
      const d = manhattan(fromRow, fromCol, c.row, c.col);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /** The bridge cell (river crossing) that best blocks the enemy's path from
   *  their side to ours — the one nearest the column line our squad will cross
   *  on. null if the map has no bridge tiles. Cached per match (terrain static). */
  private bridgeChoke: { row: number; col: number } | null | undefined = undefined;
  private chokeBridge(towardCol: number): { row: number; col: number } | null {
    if (this.bridgeChoke === undefined) {
      const bridges = getTerrain().filter((t) => t.type === 'bridge');
      if (!bridges.length) {
        this.bridgeChoke = null;
      } else {
        // Prefer the bridge column closest to the line between our castle and the
        // enemy castle, so holding it actually sits across the natural advance.
        let best = bridges[0]!;
        let bestD = Math.abs(best.col - towardCol);
        for (const b of bridges) {
          const d = Math.abs(b.col - towardCol);
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        }
        this.bridgeChoke = { row: best.row, col: best.col };
      }
    }
    return this.bridgeChoke;
  }

  /** Derive the current scenario STAGE + goals from the live board. Cached per
   *  turn (recomputed at the start of each new turn — see takeStep). Implements
   *  the deliberate game-plan: sally → ruins → bridge → arm-up → march →
   *  assault → mop-up, with a defend fallback. */
  /** Debug: force a fresh strategy computation and return it (bypasses the
   *  per-turn cache). For e2e/manual inspection only. */
  debugStrategy(): Strategy {
    this.strategy = null;
    const s = this.computeStrategy();
    this.strategy = null;
    return s;
  }

  // NOTE: the original hardcoded stage ladder (sally → ruins → bridge →
  // arm-up → march → assault → mop-up, with a defend fallback) and the
  // useGoapPlanner escape-hatch flag were removed after GOAP shipped as the
  // only strategy path — see /Users/free/.claude/plans/happy-beaming-cosmos.md
  // for the rationale (no fallback kept). Derives a WorldState from the board,
  // picks a goal by insistence, and plans the next action via backward
  // chaining (goap.ts), then maps the chosen action's stage name onto the
  // same goalRow/goalCol/pull/hold/ruinsFarmers values the old ladder used
  // per stage (a lookup by name, not independent tuning). */
  private computeStrategy(): Strategy {
    if (this.strategy) return this.strategy;
    this.strategy = this.computeStrategyGoap();
    return this.strategy;
  }

  private computeStrategyGoap(): Strategy {
    const game = this.game;
    const mine = game.ownUnits(this.player).filter((u) => u.hp > 0);
    const enemies = game.ownUnits(otherPlayer(this.player)).filter((u) => u.hp > 0);

    // castleZone honours player1Bottom — hard-coding "P1 = top rows" put
    // both castles on the wrong side in vs-AI matches (P1 sits at the bottom).
    const { row: enemyRow, col: enemyCol } = this.castleZone(otherPlayer(this.player));
    const { row: ownRow, col: ownCol } = this.castleZone(this.player);
    const enemyCastle = { row: enemyRow + 2, col: enemyCol + 2 };
    const ownDoor = { row: ownRow + 2, col: ownCol + 2 };

    const myForce = mine.reduce((s, u) => s + this.calculateUnitValue(u), 0);
    const enemyForce = enemies.reduce((s, u) => s + this.calculateUnitValue(u), 0);
    const forceRatio = myForce / Math.max(1, enemyForce);
    const forceRatioBucket: ForceRatioBucket =
      forceRatio >= 1.1 ? 'ahead' : forceRatio < 0.8 ? 'behind' : 'even';

    const inOwnCastle = mine.filter(
      (u) => u.row >= ownRow && u.row < ownRow + 4 && u.col >= ownCol && u.col < ownCol + 4,
    ).length;
    const outOfCastle = mine.length - inOwnCastle;
    const sallyDone = mine.length === 0 || outOfCastle >= Math.ceil((mine.length * 3) / 4);

    const ruinsCentre = this.nearestRuinsCentre(ownDoor.row, ownDoor.col);
    const myInRuins = mine.filter((u) => this.inRuins(u.row, u.col)).length;
    const haveRuins = ruinsCentre !== null && myInRuins >= 1;

    const choke = this.chokeBridge(enemyCastle.col);
    const onBridge = choke ? mine.some((u) => u.row === choke.row && u.col === choke.col) : false;

    const enemyDefenders = enemies.filter(
      (e) => e.row >= enemyRow && e.row < enemyRow + 4 && e.col >= enemyCol && e.col < enemyCol + 4,
    ).length;
    const myUnitsInEnemyCastle = mine.filter(
      (u) => u.row >= enemyRow && u.row < enemyRow + 4 && u.col >= enemyCol && u.col < enemyCol + 4,
    ).length;
    const enemyNearOurDoor = enemies.some(
      (e) => this.pathDist(e.row, e.col, ownDoor.row, ownDoor.col) <= 5,
    );

    const armedUnits = mine.filter((u) => u.weapon).length;
    let wellArmed = mine.length > 0 && armedUnits >= Math.min(2, mine.length);

    const RUINS_TIMEOUT = 4;
    const ARM_TIMEOUT = 3;
    if (
      !wellArmed &&
      this.armUpSinceTurn >= 0 &&
      this.myTurnCount - this.armUpSinceTurn >= ARM_TIMEOUT
    ) {
      wellArmed = true;
    }
    const ruinsTimedOut =
      this.takeRuinsSinceTurn >= 0 && this.myTurnCount - this.takeRuinsSinceTurn >= RUINS_TIMEOUT;

    const world: WorldState = deriveWorldState({
      sallyDone,
      weHoldRuins: haveRuins,
      ruinsContested: false,
      ruinsTimedOut,
      weHoldBridge: onBridge,
      wellArmed,
      forceRatioBucket,
      enemyNearOurDoor,
      weAreInEnemyCastle: myUnitsInEnemyCastle >= 1,
      enemyDefendersPresent: enemyDefenders > 0,
      enemyCastleEmpty: enemyDefenders === 0,
      enemyArmyBroken: enemies.length <= 2 || forceRatio >= 1.8,
    });

    const persona = PERSONALITIES[this.personality];
    const goal = selectGoal(world, persona.goals);
    const { step } = planStep(goal, world, persona.actions);
    const stage: StrategyStage = step
      ? step.name
      : myUnitsInEnemyCastle >= 1
        ? 'mop-up'
        : (persona.idle ?? 'march');

    // Map the chosen stage to the same goalRow/goalCol/pull/hold*/ruinsFarmers
    // values the ladder used for that branch — this is a lookup by stage name,
    // not new tuning, so Phase 1 changes ONLY which stage gets picked and when.
    let goalCell: { row: number; col: number } = enemyCastle;
    let pull = 0.5;
    let holdRow: number | null = null;
    let holdCol: number | null = null;
    let keepRuinsGuard = false;
    let ruinsFarmers = 0;

    switch (stage) {
      case 'defend':
        goalCell = ownDoor;
        pull = 0.9;
        holdRow = ownDoor.row;
        holdCol = ownDoor.col;
        break;
      case 'mop-up':
        goalCell = enemyCastle;
        pull = 1.0;
        keepRuinsGuard = true;
        break;
      case 'sally':
        goalCell = ruinsCentre ?? {
          row: Math.round((ownDoor.row + enemyCastle.row) / 2),
          col: ownDoor.col,
        };
        pull = 0.6;
        break;
      case 'take-ruins':
        goalCell = ruinsCentre ?? enemyCastle;
        pull = 0.8;
        break;
      case 'hold-bridge':
        goalCell = choke ?? enemyCastle;
        pull = 0.6;
        holdRow = choke ? choke.row : null;
        holdCol = choke ? choke.col : null;
        keepRuinsGuard = true;
        ruinsFarmers = 3;
        break;
      case 'arm-up':
        goalCell = choke ?? enemyCastle;
        pull = 0.5;
        holdRow = choke ? choke.row : null;
        holdCol = choke ? choke.col : null;
        keepRuinsGuard = true;
        ruinsFarmers = 3;
        break;
      case 'assault':
        goalCell = enemyCastle;
        pull = 1.0;
        keepRuinsGuard = true;
        break;
      case 'march':
        goalCell = enemyCastle;
        pull = 0.75;
        keepRuinsGuard = true;
        break;
      case 'hunt': {
        // Berserker: head for the enemy unit nearest our army's centre.
        const cr = mine.reduce((a, u) => a + u.row, 0) / Math.max(1, mine.length);
        const cc = mine.reduce((a, u) => a + u.col, 0) / Math.max(1, mine.length);
        let best: { row: number; col: number } | null = null;
        let bestD = Infinity;
        for (const e of enemies) {
          const d = Math.abs(e.row - cr) + Math.abs(e.col - cc);
          if (d < bestD) {
            bestD = d;
            best = { row: e.row, col: e.col };
          }
        }
        goalCell = best ?? enemyCastle;
        pull = 1.0;
        break;
      }
    }
    pull = Math.min(1, pull * persona.pull);
    if (ruinsFarmers > 0) ruinsFarmers = persona.ruinsFarmers;

    this.takeRuinsSinceTurn =
      stage === 'take-ruins' ? (this.takeRuinsSinceTurn < 0 ? this.myTurnCount : this.takeRuinsSinceTurn) : -1;
    this.armUpSinceTurn =
      stage === 'arm-up' ? (this.armUpSinceTurn < 0 ? this.myTurnCount : this.armUpSinceTurn) : -1;

    return {
      stage,
      goalRow: goalCell.row,
      goalCol: goalCell.col,
      pull,
      holdRow,
      holdCol,
      keepRuinsGuard,
      ruinsFarmers,
    };
  }

  /** Strategic bias for a candidate destination cell. Rewards progress toward
   *  the stage goal, plus stage-specific pulls: occupying a hold cell (bridge /
   *  door), capturing & guarding the ruins. Sits at the low-hundreds scale (same
   *  as the old q-bias) so it nudges ties without overriding the tactical
   *  heuristic. `unit` is the unit being scored; `from` is its current cell. */
  private strategyBias(
    toRow: number,
    toCol: number,
    from: { row: number; col: number },
    unit?: Unit,
  ): number {
    const w = this.config.strategyWeight ?? 0;
    if (w <= 0) return 0;
    const s = this.computeStrategy();
    let bias = 0;

    // Base: ~250 per cell of path-progress toward the stage goal × pull.
    const before = this.pathDist(from.row, from.col, s.goalRow, s.goalCol);
    const after = this.pathDist(toRow, toCol, s.goalRow, s.goalCol);
    bias += (before - after) * 250 * s.pull;

    // Hold-cell pull (bridge chokepoint / own door): reward the unit nearest the
    // hold cell for moving onto / staying on it, so exactly one unit anchors it.
    if (s.holdRow !== null && s.holdCol !== null) {
      const nearestToHold = this.nearestUnitTo(s.holdRow, s.holdCol);
      if (!unit || !nearestToHold || unit.id === nearestToHold.id) {
        const dTo = this.pathDist(toRow, toCol, s.holdRow, s.holdCol);
        const dFrom = this.pathDist(from.row, from.col, s.holdRow, s.holdCol);
        bias += (dFrom - dTo) * 700; // strong, single-unit anchor pull
        if (toRow === s.holdRow && toCol === s.holdCol) bias += 1500; // sit on it
      }
    }

    // Capture/guard the ruins: reward standing on a ruins cell during the stages
    // that care, but keep just one guard there once we're marching.
    if (this.inRuins(toRow, toCol)) {
      if (s.stage === 'take-ruins' || s.stage === 'arm-up') bias += 900;
      else if (s.keepRuinsGuard) {
        const guards = this.game
          .ownUnits(this.player)
          .filter((u) => u.hp > 0 && u.id !== (unit ? unit.id : -1) && this.inRuins(u.row, u.col)).length;
        // Only the first unit gets the guard bonus; others are free to march on.
        bias += guards === 0 ? 700 : -400;
      }
    }

    return bias * w;
  }

  /** Closest living friendly unit to a cell (ties broken arbitrarily). */
  private nearestUnitTo(row: number, col: number): Unit | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of this.game.ownUnits(this.player)) {
      if (u.hp <= 0) continue;
      const d = this.pathDist(u.row, u.col, row, col);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  reset(): void {
    // A think still running for the previous match must not land in this one.
    this.chanceGen++;
    this.chanceBusy = false;
    this.chanceNext = null;
    this.chanceLastProb = null;
    this.frameCounter = 0;
    this.beamGen++;
    this.beamBusy = false;
    this.beamPlan = null;
    this.strategyCache.clear();
    this.turnPlan = null;
    this.strategy = null;
    this.bridgeChoke = undefined; // re-derive: map layout can change between games
    this.focusTarget = null;
    this.watchdogSig = '';
    this.watchdogStall = 0;
    this.myTurnCount = 0;
    this.armUpSinceTurn = -1;
    this.takeRuinsSinceTurn = -1;
    this.mctsRoot = null;
    this.thinkProgress = null;
    // A retained tree describes the PREVIOUS game's position — never reuse it
    // across a reset, or the first think would re-root into a stale subtree.
    this.mctsRetained = null;
    this.mctsReusedNodes = 0;
    this.mctsIterCostMs = 4;
    this.lastSearchStats = null;
    // Abandon any off-thread search: its result describes the old position.
    this.searchWorker?.cancelActive();
    this.workerBusy = false;
    this.workerPlan = null;
  }

  /** Release the search worker. Call when the AI is torn down for good. */
  dispose(): void {
    this.searchWorker?.dispose();
    this.searchWorker = null;
    this.workerBusy = false;
    this.workerPlan = null;
  }

  // Counts this AI's own turns (bumped when a fresh turn-plan is built). Used to
  // time out stages that would otherwise camp forever (e.g. chasing unreachable
  // ruins, or waiting to arm up on a map with no artifacts to pick up).
  private myTurnCount = 0;
  private armUpSinceTurn = -1; // turn this AI first entered arm-up (−1 = not in it)
  private takeRuinsSinceTurn = -1; // turn this AI first entered take-ruins

  update(): void {
    const game = this.game;
    if (!game.isGameActive()) return;
    if (game.mode !== 'ai') return;
    if (game.currentPlayer !== this.player) return;
    if (game.winner !== null) return;
    if (this.chanceTarget !== null) {
      try {
        this.chanceStep();
      } catch (err) {
        console.error('Chance AI step failed; forcing end of turn.', err);
        this.chanceBusy = false;
        this.chanceNext = null;
        this.thinkProgress = null;
        this.endTurnSafely();
      }
      return;
    }
    // While thinking (either think path) run every frame so the progress bar
    // animates smoothly; otherwise honour the frameWait pacing.
    if (this.mctsRoot === null && !this.workerBusy && !this.beamBusy) {
      this.frameCounter += 1;
      if (this.frameCounter < this.frameWait) return;
      this.frameCounter = 0;
    }
    try {
      this.takeStep();
    } catch (err) {
      // Never let the bot get stuck mid-turn: log and hand the turn back so
      // the human is not frozen out (замечание №4).
      console.error('AI turn step failed; forcing end of turn.', err);
      this.endTurnSafely();
    }
  }

  /** Reset watchdog state and force the AI turn to end, swallowing errors. */
  // ── "Свой шанс": steer the AI's win probability to a chosen target ───────
  // Win probability of a position = share of the game tree's branches below
  // it that end in the AI's win, estimated by sampling random branches to the
  // end (chance-worker.ts, one worker per core). Each AI action: score up to
  // CHANCE_CANDIDATES legal actions that way and play the one whose
  // probability is closest to the target (an immediately winning action is
  // always taken). Target 100% = always the action with the best chances.
  private chanceTarget: number | null = null;
  /** GOAP personality (goap.ts PERSONALITIES), from the "@name" suffix of the difficulty. */
  personality: Personality = 'strategist';
  private chanceBusy = false;
  private chanceNext: ServerAction | null = null;
  private chanceLastProb: number | null = null;
  private chanceGen = 0;
  private static chancePool: Worker[] | null = null;
  // Up to 10 candidates; 2 short samples each in the first halving round,
  // doubling per round (~96 samples per action). Each sample is a 200-action
  // random branch scored by the static evaluation (see chance-worker.ts):
  // ~1 s per AI turn.
  private static readonly CHANCE_CANDIDATES = 10;
  private static readonly CHANCE_SAMPLES = 2;
  private static readonly CHANCE_MAX_LEN = 200;

  /** Last estimated AI win chance after its chosen action (for the HUD). */
  get chanceEstimate(): number | null {
    return this.chanceLastProb;
  }

  private static pool(): Worker[] {
    if (!AIPlayer.chancePool) {
      const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
      AIPlayer.chancePool = Array.from(
        { length: n },
        () => new Worker(new URL('./chance-worker.ts', import.meta.url), { type: 'module' }),
      );
    }
    return AIPlayer.chancePool;
  }

  private chanceStep(): void {
    const game = this.game;
    if (this.chanceBusy) {
      game.renderSidebar(); // keep the progress bar moving
      return;
    }
    if (this.chanceNext) {
      const a = this.chanceNext;
      this.chanceNext = null;
      if (a.kind === 'end-turn') {
        game.forceEndTurn();
        return;
      }
      const entry = toPlanEntry(a, game.player1Bottom);
      const unit = entry && game.board.units.find((u: Unit) => u.id === entry.unitId && u.alive());
      if (!entry || !unit || !game.canUnitAct(unit)) {
        game.forceEndTurn();
        return;
      }
      game.selectUnit(unit.row, unit.col, true);
      if (game.selectedUnit?.id === unit.id) this.executeAction(entry.action);
      else game.forceEndTurn();
      return;
    }

    // Think about the next action.
    const state = snapshotGameState(game);
    const rng = rulesRng(1);
    const mappable = new Set(['move', 'attack', 'craft', 'craft-armor', 'castle-heal', 'mage-attack', 'mage-ward', 'mage-drain', 'mage-heal', 'mage-burn-bridge', 'build-tower', 'build-bridge']);
    const kids: Array<{ a: ServerAction; s: GameState }> = [];
    for (const a of [...generateActionsForPlayer(state, this.player), { kind: 'end-turn' } as ServerAction]) {
      if (a.kind !== 'end-turn' && !mappable.has(a.kind)) continue;
      const r = rulesApply(state, a, rng);
      if (!r.ok) continue;
      if (r.value.winner === this.player) {
        this.chanceNext = a; // a winning action needs no thinking
        this.chanceLastProb = 1;
        return;
      }
      kids.push({ a, s: r.value });
    }
    if (kids.length === 1) {
      this.chanceNext = kids[0]!.a;
      return;
    }
    // Pre-rank every action by the fitted formula N = winChance() (instant),
    // then spend the playouts only on the CHANCE_CANDIDATES whose N is closest
    // to the target — instead of a random 10, which could miss the best move.
    const target = this.chanceTarget ?? 1;
    const ranked = kids
      .map((k) => ({ k, gap: Math.abs(winChance(k.s, this.player) - target) + Math.random() * 1e-9 }))
      .sort((x, y) => x.gap - y.gap);
    const pick = ranked.slice(0, AIPlayer.CHANCE_CANDIDATES).map((r) => r.k);
    const workers = AIPlayer.pool();
    const gen = this.chanceGen;
    this.chanceBusy = true;
    this.thinkProgress = 0;
    game.renderSidebar();

    // One batch of short samples for candidate `i`, on whichever worker is free.
    const free = [...workers];
    const waiting: Array<() => void> = [];
    const sample = (i: number, n: number): Promise<{ wins: number; samples: number }> =>
      new Promise((resolve) => {
        const run = () => {
          const w = free.pop()!;
          w.onmessage = (e: MessageEvent<{ wins: number; samples: number }>) => {
            free.push(w);
            waiting.shift()?.();
            resolve(e.data);
          };
          w.postMessage({
            id: i,
            state: pick[i]!.s,
            samples: n,
            maxLen: AIPlayer.CHANCE_MAX_LEN,
            player: this.player,
            seed: (Math.random() * 2 ** 31) | 0,
          });
        };
        if (free.length) run();
        else waiting.push(run);
      });

    // Successive halving: every candidate gets a few samples, the half whose
    // probability is furthest from the target is dropped, the survivors get
    // twice as many, and so on until one is left. Samples go where the
    // decision is actually close instead of being spread evenly.
    const wins = new Array<number>(pick.length).fill(0);
    const seen = new Array<number>(pick.length).fill(0);
    const prob = (i: number) => wins[i]! / Math.max(1, seen[i]!);
    void (async () => {
      let alive = pick.map((_, i) => i);
      let per = AIPlayer.CHANCE_SAMPLES;
      const rounds = Math.max(1, Math.ceil(Math.log2(alive.length)));
      for (let round = 0; round < rounds && alive.length > 1; round++) {
        const results = await Promise.all(
          alive.flatMap((i) => {
            const chunk = Math.ceil(per / workers.length);
            return Array.from({ length: Math.ceil(per / chunk) }, () => sample(i, chunk).then((r) => ({ i, r })));
          }),
        );
        if (gen !== this.chanceGen) return; // a new match started meanwhile
        for (const { i, r } of results) {
          wins[i] += r.wins;
          seen[i] += r.samples;
        }
        alive.sort((a, b) => Math.abs(prob(a) - target) - Math.abs(prob(b) - target));
        alive = alive.slice(0, Math.max(1, Math.ceil(alive.length / 2)));
        per *= 2;
        this.thinkProgress = (round + 1) / rounds;
      }
      if (gen !== this.chanceGen) return;
      const best = alive[0]!;
      this.chanceNext = pick[best]!.a;
      this.chanceLastProb = prob(best);
      this.chanceBusy = false;
      this.thinkProgress = null;
    })();
  }

  private endTurnSafely(): void {
    this.turnPlan = null;
    this.watchdogSig = '';
    this.watchdogStall = 0;
    this.mctsRoot = null;
    this.thinkProgress = null;
    this.searchWorker?.cancelActive();
    this.workerBusy = false;
    this.workerPlan = null;
    try {
      this.game.forceEndTurn();
    } catch (err) {
      console.error('AI forceEndTurn failed.', err);
    }
  }

  /**
   * A compact fingerprint of turn progress: own unit count, how many are done,
   * total moves left, the selected unit, and pending prompts. It changes on
   * every real action; if it stays identical for many steps the AI is stuck.
   */
  private progressSignature(): string {
    const game = this.game;
    const mine = game.ownUnits(this.player);
    let done = 0;
    let moves = 0;
    for (const u of mine) {
      if (u.done) done += 1;
      moves += Math.max(0, u.movesLeft);
    }
    const sel = game.selectedUnit ? game.selectedUnit.id : -1;
    const pend = (game.pendingWeaponEquip ? 1 : 0) + (game.pendingCastleHealing ? 2 : 0);
    return `${mine.length}|${done}|${moves}|${sel}|${pend}`;
  }

  private takeStep(): void {
    const game = this.game;
    if (game.currentPlayer !== this.player || game.winner !== null) return;

    // Watchdog: if the turn makes no measurable progress for many steps, the
    // AI is stuck — force the turn to end rather than freeze the game. EXCEPTION:
    // while the MCTS is thinking the board hasn't changed yet on purpose — the
    // search IS the progress — so don't count those frames or the watchdog would
    // abort the think early (the "skips at 18%" bug).
    //
    // Both think paths must be exempt: `mctsRoot` is set only by the in-thread
    // frame-sliced search, while the off-thread worker leaves it null and tracks
    // its own in-flight state in `workerBusy`. Checking only the former let the
    // watchdog kill every worker-backed turn after WATCHDOG_MAX_STALL frames.
    if (this.mctsRoot !== null || this.workerBusy || this.beamBusy) {
      this.watchdogStall = 0;
    } else {
      const sig = this.progressSignature();
      if (sig === this.watchdogSig) {
        this.watchdogStall += 1;
      } else {
        this.watchdogSig = sig;
        this.watchdogStall = 0;
      }
      if (this.watchdogStall > AIPlayer.WATCHDOG_MAX_STALL) {
        console.warn('AI watchdog: no progress; forcing end of turn.');
        this.endTurnSafely();
        return;
      }
    }

    if (game.pendingWeaponEquip) {
      const targets = game.weaponEquipTargets(game.pendingWeaponEquip);
      if (targets.length > 0) {
        const isArmor = game.pendingWeaponEquip.slot === 'armor';
        // Put armour on the sturdiest frontline unit (soak hits); put a weapon on
        // the biggest hitter (maximise damage output). Previously the AI handed
        // gear to the *weakest* unit — a clear waste.
        targets.sort((a, b) =>
          isArmor ? b.hp + b.maxArmor - (a.hp + a.maxArmor) : b.damage - a.damage,
        );
        const first = targets[0];
        if (first) game.equipPendingWeapon(first.id);
      } else {
        game.pendingWeaponEquip = null;
        game.renderSidebar();
      }
      return;
    }

    if (game.pendingCastleHealing) {
      const pending = game.pendingCastleHealing;
      const unit = game.board.units.find((u: Unit) => u.id === pending.unitId);
      game.pendingCastleHealing = null;
      if (unit) {
        if (pending.needsHp && unit.hp < unit.maxHp) {
          unit.hp += Math.min(2, unit.maxHp - unit.hp);
          game.lastEvent = unit.name + ' восстановил HP в замке.';
        } else if (pending.needsArmor && unit.armor < unit.startArmor) {
          unit.armor += Math.min(2, unit.startArmor - unit.armor);
          game.lastEvent = unit.name + ' восстановил защиту в замке.';
        }
        unit.done = true;
        unit.movesLeft = 0;
        game.selectedUnit = null;
        game.clearHighlights();
        if (game.shouldEndTurn()) game.endTurn();
        else game.renderSidebar();
      }
      return;
    }

    // This fast path drives a unit with strategicFollowUp/bestActionForUnit
    // OUTSIDE the turnPlan array entirely. It must never fire while a search
    // plan is still queued: performMove/performAttack in main.ts deliberately
    // leave the acted-on unit selected whenever it has movesLeft left (so a
    // human can keep clicking the same unit), which means EVERY frame after
    // the turnPlan path executes one multi-move unit's first step, this block
    // would win the race at the top of takeStep() and hijack that unit away
    // from its own plan — via a FRESH strategicFollowUp call, not the plan's
    // next entry. The unit then ends up wherever this fast path sends it,
    // while the plan's now-stale next entry for that same unit (computed
    // against its pre-hijack position) sits unconsumed in this.turnPlan. If
    // the fast path happens to land the unit exactly on that stale entry's
    // target cell, the entry becomes a same-cell "move" and the game rejects
    // it outright — measured live: 4 of 41 planned moves (9.8%), always with
    // a landing square equal to the mover's own current cell.
    const planActive = this.turnPlan !== null && this.turnPlan.length > 0;
    if (!planActive && game.selectedUnit && game.selectedUnit.player === this.player) {
      const sel = game.selectedUnit;
      if (sel.movesLeft <= 0 || sel.done) {
        sel.done = true;
        sel.movesLeft = 0;
        game.selectedUnit = null;
        game.clearHighlights();
        if (game.shouldEndTurn()) game.endTurn();
        else game.renderSidebar();
        return;
      }
      // Multi-step march at FULL SPEED: a runner spends ALL its move points in
      // this single step, dashing the whole way toward the ruins instead of one
      // cell per frame. We loop strategicFollowUp + execute while it keeps making
      // progress and has movement left (capped by its move budget so it can never
      // spin). Falls back to the full tactical scorer when there's no strategic
      // step — that path executes once and returns.
      const firstFollow = this.strategicFollowUp(sel);
      if (firstFollow) {
        let budget = sel.movesLeft + 1; // hard cap against any non-advancing loop
        let step: AIAction | null = firstFollow;
        while (step && sel.movesLeft > 0 && !sel.done && budget-- > 0) {
          const before = sel.row * 100 + sel.col;
          this.executeAction(step);
          if (sel.row * 100 + sel.col === before) break; // didn't actually move → stop
          step = this.strategicFollowUp(sel);
        }
        return;
      }
      this.executeAction(this.bestActionForUnit(sel));
      return;
    }

    const candidates = game
      .ownUnits(this.player)
      .filter((u) => !u.done)
      .filter((u) => game.canUnitAct(u));
    if (!candidates.length) {
      this.turnPlan = null;
      this.mctsRoot = null;
      this.thinkProgress = null;
      game.forceEndTurn();
      return;
    }
    if (!this.turnPlan || this.turnPlan.length === 0) {
      // Fresh turn: re-derive the phase/goal once, then plan against it.
      // When MCTS is on, the search runs TIME-SLICED across frames so the screen
      // keeps painting and the "thinking" progress bar animates. We spend one
      // ~40 ms slice per frame and only build the plan once the search finishes.
      // The measured difficulty ladder (game-rules beam-presets.ts, verified by
      // scripts/ladder.mjs): beam + playouts on a pool of workers. Before this
      // it was only a fallback behind the MCTS worker below, so the browser
      // never actually played the levels the ladder measured.
      if (this.config.useBeamSearch) {
        const plan = this.consumeBeamPlan();
        if (plan === null) return; // still thinking — keep painting
        if (plan.length === 0) {
          game.forceEndTurn();
          return;
        }
        this.turnPlan = plan;
        AIPlayer.tallyPlan(this.turnPlan);
        return;
      }
      if (this.config.useMCTS) {
        // Preferred path: search entirely off the main thread. Frame-slicing
        // still blocks the main thread for the length of every slice, which on
        // `hard` means hundreds of consecutive blocking chunks per turn.
        if (this.useWorkerSearch()) {
          const plan = this.consumeWorkerPlan();
          if (plan === null) return; // still thinking — keep painting
          const myUnits = game
            .ownUnits(this.player)
            .filter((u) => !u.done && game.canUnitAct(u));
          this.turnPlan =
            plan.length > 0 ? this.applyStrategicOverlay(plan, myUnits) : this.createTurnPlan();
          AIPlayer.tallyPlan(this.turnPlan);
          return;
        }
        // Fallback: in-thread, frame-sliced search (no Worker in this runtime).
        if (this.mctsRoot === null) {
          this.strategy = null;
          this.myTurnCount += 1;
          this.selectFocusTarget();
          this.mctsBegin();
          game.renderSidebar(); // show the bar at 0% immediately
        }
        const done = this.mctsSlice(40);
        game.renderSidebar(); // repaint the bar each frame
        if (!done) return; // keep thinking next frame
        // Search finished — turn the MCTS result into the turn plan, then clear.
        const myUnits = game
          .ownUnits(this.player)
          .filter((u) => !u.done && game.canUnitAct(u));
        const plan = this.mctsFinish();
        this.turnPlan = plan.length > 0 ? this.applyStrategicOverlay(plan, myUnits) : this.createTurnPlan();
        AIPlayer.tallyPlan(this.turnPlan);
      } else {
        this.strategy = null;
        this.myTurnCount += 1;
        this.turnPlan = this.createTurnPlan();
        AIPlayer.tallyPlan(this.turnPlan);
      }
    }
    const nextEntry = this.turnPlan.shift();
    if (!nextEntry) {
      const sorted = this.sortUnitsByPriority(candidates);
      const best = sorted[0];
      if (!best) {
        game.forceEndTurn();
        return;
      }
      game.selectUnit(best.unit.row, best.unit.col, true);
      if (game.selectedUnit && game.selectedUnit.id === best.unit.id) {
        const action = this.bestActionForUnit(game.selectedUnit) ?? {
          type: 'skip',
          score: -300,
        };
        this.executeAction(action);
      }
      return;
    }
    // Walk forward to the first entry the game will actually accept. An entry
    // can be unexecutable if its unit died, finished, or — the case that caused
    // the bot to stand still for whole games — the turn's activation budget ran
    // out. Dropping just one entry per frame does nothing visible and wastes
    // the frame, so skip the dead ones here instead of returning empty-handed.
    let entry: PlanEntry | undefined = nextEntry;
    while (entry) {
      const targetUnit = game.board.units.find(
        (u: Unit) => u.id === entry!.unitId && u.alive(),
      );
      if (targetUnit && !targetUnit.done && game.canUnitAct(targetUnit)) {
        game.selectUnit(targetUnit.row, targetUnit.col, true);
        if (game.selectedUnit && game.selectedUnit.id === targetUnit.id) {
          // The plan was made for the board at the START of the turn; earlier
          // entries may since have filled this destination or killed this
          // target. Playing a stale entry got it rejected and burned the
          // unit's activation — re-decide for this unit on the live board.
          const action = this.isStillLegal(game.selectedUnit, entry.action)
            ? entry.action
            : (this.bestActionForUnit(game.selectedUnit) ?? { type: 'skip', score: -300 });
          this.executeAction(action);
          return;
        }
      }
      entry = this.turnPlan.shift();
    }
    // Every remaining entry was unexecutable — the plan is spent. End the turn
    // rather than idling until the watchdog notices.
    this.turnPlan = null;
    game.forceEndTurn();
  }

  private createTurnPlan(): PlanEntry[] {
    const game = this.game;
    const myUnits = game.ownUnits(this.player).filter((u) => !u.done && game.canUnitAct(u));
    if (!myUnits.length) return [];
    if (this.config.randomMoveChance > 0 && Math.random() < this.config.randomMoveChance) {
      return this.createRandomPlan(myUnits);
    }
    // Beam search engine (plan step 6) — opt-in alternative to
    // combo-detection/MCTS/minimax below, selected by BeamDifficulty preset
    // name. See ai-config.ts's useBeamSearch doc comment. Bypasses
    // applyStrategicOverlay entirely: like trustSearch, the beam search's own
    // evaluate() already accounts for castle pressure/economy/positioning, so
    // rewriting its plan with the scenario script would only undo what it chose.
    if (this.config.useBeamSearch) {
      const tilt = PERSONALITIES[this.personality].weights;
      const beamConfig = BEAM_DIFFICULTY[this.config.useBeamSearch];
      const weights = Object.keys(tilt).length ? scaleWeights(tilt, baseWeightsFor(beamConfig)) : undefined;
      const plan = beamPlanFor(game, this.player, beamConfig, weights);
      if (plan.length > 0) return plan;
    }
    this.selectFocusTarget();
    if (this.config.comboDetection) {
      // Combos SHORT-CIRCUIT the search: whatever this returns is played, and
      // the MCTS below never runs. That made it the single most damaging line in
      // the AI — detectCombos accepts any pair of units whose damage sums to the
      // target's hp, sorted by how valuable the target is, with no check on what
      // the attackers lose. Observed in a real game: the bot fed two units into
      // a "combo" and killed nothing, because buildComboPlan takes attacks[0]
      // (an arbitrary landing square) and the second attacker died before it
      // could swing.
      //
      // A combo now has to be worth playing INSTEAD of a 1.5s search: only
      // profitable trades qualify, and anything else falls through to MCTS,
      // which evaluates the same attacks properly among all other options.
      const combos = this.detectCombos(myUnits).filter((c) => this.comboIsProfitable(c));
      const first = combos[0];
      if (first) {
        const comboPlan = this.buildComboPlan(first, myUnits);
        if (comboPlan.length > 0) return comboPlan;
      }
    }
    // Phase 3: MCTS — runs instead of minimax when useMCTS is true.
    // Sees 10+ turns ahead via rollouts; much stronger than fixed-depth search.
    if (this.config.useMCTS) {
      const plan = this.mctsSearch();
      if (plan.length > 0) return this.applyStrategicOverlay(plan, myUnits);
    }
    if (this.config.useMinimax && this.config.minimaxDepth >= 1) {
      // Phase 2 AI overhaul: real minimax with α-β pruning over turn-plans,
      // iterative deepening, and Zobrist transposition table. Falls back to
      // the greedy sequential plan if search returns nothing.
      const searched = this.searchBestPlan();
      if (searched.length > 0) return this.applyStrategicOverlay(searched, myUnits);
      const seqPlan = this.createSequentialPlan(myUnits);
      if (seqPlan.length > 0) return this.applyStrategicOverlay(seqPlan, myUnits);
    }
    const currentEval = this.evaluatePosition();
    const maxUnits = Math.min(3, myUnits.length);
    const unitCombinations = this.generateUnitCombinations(myUnits, maxUnits);
    let bestPlan: PlanEntry[] = [];
    let bestScore = -Infinity;
    unitCombinations.slice(0, this.config.combinationLimit).forEach((combo) => {
      const plan = this.generatePlanForCombination(combo);
      const score = this.evaluatePlan(plan, currentEval);
      if (score > bestScore) {
        bestScore = score;
        bestPlan = plan;
      }
    });
    return bestPlan;
  }

  /** Cheap economy action for an idle unit during the strategic overlay: draw an
   *  artifact if standing in ruins, else craft an affordable weapon/armor for
   *  which a valid recipient exists. Mirrors the craft/draw branch of
   *  bestActionForUnit but skips all the expensive attack/move scoring, so it's
   *  safe to run for every idle unit each turn. Returns null when nothing applies. */
  private cheapEconomyAction(unit: Unit, allies: Unit[]): AIAction | null {
    const game = this.game;
    if (unit.movesLeft < 1 || this.config.economyWeight <= 0) return null;
    if (game.board.inRuins(unit.row, unit.col)) {
      return { type: 'draw', score: 3000 + this.evaluateArtifactNeed() };
    }
    if (game.pendingWeaponEquip) return null;
    // Parts live in the crafter's own backpack, and gear the crafter can't
    // wear is just dropped on the ground — so only craft what it can wear.
    void allies;
    for (let wi = 0; wi < WEAPONS.length; wi += 1) {
      const w = WEAPONS[wi]!;
      if (!game.canAfford(unit.backpack, w.recipe)) continue;
      if (!game.canEquipWeaponToUnit(w, unit)) continue;
      return { type: 'craft', index: wi, score: 9000 * this.config.economyWeight };
    }
    for (let ai = 0; ai < ARMORS.length; ai += 1) {
      const a = ARMORS[ai]!;
      if (!game.canAfford(unit.backpack, a.recipe)) continue;
      if (!game.canEquipWeaponToUnit(a, unit)) continue;
      return { type: 'craft-armor', index: ai, score: 8000 * this.config.economyWeight };
    }
    return null;
  }

  /** Variant A — strategic overlay on top of the search plan. The MCTS/minimax
   *  search optimises tactics (kills, defense) but, evaluating whole positions,
   *  it won't reliably commit a unit to the long march over a one-wide bridge: a
   *  single unit's progress is a rounding error in the position score. So we
   *  post-process the search plan PER UNIT (where the strategic gradient is
   *  clean): keep every non-move action (attack/craft/draw/spell/heal) and every
   *  move that already makes strategic progress, but redirect aimless shuffles —
   *  and fill in idle units — toward the stage goal (with a cheap economy check
   *  first). Tactics/economy are never dropped; only wasted tempo is redirected. */
  private applyStrategicOverlay(plan: PlanEntry[], myUnits: Unit[]): PlanEntry[] {
    if ((this.config.strategyWeight ?? 0) <= 0) return plan;

    // TRUST-SEARCH mode (hard / high intelligence): the deep search already found
    // a strong plan — don't rewrite it with the scenario march/rally/farmer
    // script (that was wasting the extra thinking). Keep every search action; only
    // give a sensible nudge to units the search left IDLE (toward the stage goal)
    // so nobody wastes a turn, and let an idle unit grab a free adjacent kill.
    if (this.config.trustSearch) {
      const s = this.computeStrategy();
      const acted = new Set(plan.map((e) => e.unitId));
      const result = [...plan];
      // Idle units may only be filled in while activation slots remain. The game
      // activates at most `maxActivatedPerTurn` DISTINCT units per turn and
      // refuses every action after that, so appending a move for each idle unit
      // (the old behaviour) produced plans where most entries were dead on
      // arrival: measured 7 planned units against a cap of 3.
      let slotsLeft = this.activationBudget() - acted.size;
      const occupied = new Set<string>();
      for (const u of this.game.board.units) if (u.hp > 0) occupied.add(u.row + ',' + u.col);
      for (const e of plan) {
        if (e.action.type === 'move' && e.action.row != null && e.action.col != null) {
          const u = myUnits.find((m) => m.id === e.unitId);
          if (u) {
            occupied.delete(u.row + ',' + u.col);
            occupied.add(e.action.row + ',' + e.action.col);
          }
        }
      }
      for (const unit of myUnits) {
        if (acted.has(unit.id)) continue;
        if (slotsLeft <= 0) break; // no activation slots left — the game would refuse
        const atk = this.bestAttackAction(unit);
        if (atk) {
          result.push({ unitId: unit.id, action: atk });
          acted.add(unit.id);
          slotsLeft -= 1;
          continue;
        }
        // March idle unit one step toward the stage goal (cheap, keeps tempo).
        const cur = this.pathDist(unit.row, unit.col, s.goalRow, s.goalCol);
        let best: { row: number; col: number; d: number } | null = null;
        for (const m of this.game.moveActionsFor(unit)) {
          if (occupied.has(m.row + ',' + m.col)) continue;
          const d = this.pathDist(m.row, m.col, s.goalRow, s.goalCol);
          if (!best || d < best.d) best = { row: m.row, col: m.col, d };
        }
        if (best && best.d < cur) {
          occupied.delete(unit.row + ',' + unit.col);
          occupied.add(best.row + ',' + best.col);
          result.push({ unitId: unit.id, action: { type: 'move', row: best.row, col: best.col, score: 0 } });
          acted.add(unit.id);
          slotsLeft -= 1;
        }
      }
      return result;
    }

    const s = this.computeStrategy();
    const byUnit = new Map<number, PlanEntry>();
    for (const e of plan) byUnit.set(e.unitId, e);

    // The cell each unit should progress toward. The single anchor unit (closest
    // to the hold cell) marches to the hold cell (bridge/door); the rest head for
    // the stage goal. Keep ONE ruins guard parked when keepRuinsGuard is set.
    const anchor =
      s.holdRow !== null && s.holdCol !== null ? this.nearestUnitTo(s.holdRow, s.holdCol) : null;
    const ruinsGuard = s.keepRuinsGuard
      ? myUnits.find((u) => this.inRuins(u.row, u.col)) ?? null
      : null;
    // Our own castle 4×4 zone (canonical: P2 top, P1 bottom — castleZone handles it).
    const own = this.castleZone(this.player);
    const inOwnCastle = (r: number, c: number): boolean =>
      r >= own.row && r < own.row + 4 && c >= own.col && c < own.col + 4;
    // The row just OUTSIDE the castle toward the field (down for a top castle, up
    // for a bottom one). Units still inside aim here first so a single step out of
    // the gate always counts as progress — otherwise the far goal's path-distance
    // is nearly flat inside the cramped 4×4 box and units mill instead of leaving.
    const exitRow = own.row === 0 ? 4 : own.row - 1;

    // ── Post-ruins roles: N farmers stay & level in the ruins; knights+archers
    // hold the bridge; 1-2 vanguard runners sprint ahead in the opening ──────
    // Computed by goap.ts's assignRoles (moved there verbatim in Phase 2 — see
    // the plan file). ai.ts still owns targetFor()/the execution loop below.
    const ruinsCentre = this.nearestRuinsCentre(own.row + 2, own.col + 2);
    const ruinsCellsFlat: { row: number; col: number }[] = [];
    for (const r of getAllRuins()) {
      for (let rr = r.top; rr < r.top + r.height; rr++)
        for (let cc = r.left; cc < r.left + r.width; cc++) ruinsCellsFlat.push({ row: rr, col: cc });
    }
    const roles = assignRoles({
      units: myUnits.map((u) => ({ id: u.id, row: u.row, col: u.col, type: u.type, maxMoves: u.maxMoves })),
      ruinsCells: ruinsCellsFlat,
      ruinsCentre,
      ownCentre: { row: own.row + 2, col: own.col + 2 },
      ruinsFarmers: s.ruinsFarmers,
      stage: s.stage,
      goalRow: s.goalRow,
      goalCol: s.goalCol,
      pathDist: (fr, fc, tr, tc) => this.pathDist(fr, fc, tr, tc),
      inRuins: (r, c) => this.inRuins(r, c),
    });
    const { farmers, farmerCell, bridgeSquad, vanguard, skirmishers } = roles;
    const bridgeCell =
      s.holdRow !== null && s.holdCol !== null ? { row: s.holdRow, col: s.holdCol } : null;

    // Is an enemy threatening the ruins? If so, farmers must DEFEND (fight / move
    // to intercept) instead of calmly searching. "подхожу к ним → приоритет отбить
    // руины, а не качаться."
    const enemies = this.game.ownUnits(otherPlayer(this.player)).filter((u) => u.hp > 0);
    const enemyNearRuins =
      ruinsCentre !== null &&
      enemies.some((e) => this.pathDist(e.row, e.col, ruinsCentre.row, ruinsCentre.col) <= 4);

    const targetFor = (u: Unit): { row: number; col: number } => {
      // Farmers head for their OWN assigned ruins cell. But if an enemy is
      // threatening the ruins, a farmer instead targets that intruder to drive it
      // off (defend the ruins rather than search).
      if (farmers.has(u.id)) {
        if (enemyNearRuins) {
          let near: { row: number; col: number } | null = null;
          let nd = Infinity;
          for (const e of enemies) {
            const d = this.pathDist(u.row, u.col, e.row, e.col);
            if (d >= 0 && d < nd) {
              nd = d;
              near = { row: e.row, col: e.col };
            }
          }
          if (near) return near;
        }
        if (this.inRuins(u.row, u.col)) return { row: u.row, col: u.col };
        return farmerCell.get(u.id) ?? ruinsCentre ?? { row: u.row, col: u.col };
      }
      // Catapults hang back from the bridge/goal at a cell inside their firing
      // band (CATAPULT_MIN_RANGE..CATAPULT_MAX_RANGE) instead of stacking onto
      // the chokepoint itself — sitting closer than the min range makes them
      // unable to fire at all. Aim for a cell CATAPULT_MIN_RANGE+1 behind the
      // bridgeSquad's objective, back toward our own castle, biased inside the
      // usable band; the greedy movement step below still routes around
      // obstacles, this only sets the destination.
      if (skirmishers.has(u.id)) {
        const anchorCell = bridgeCell ?? { row: s.goalRow, col: s.goalCol };
        const standoff = CATAPULT_MIN_RANGE + 1;
        const dr = own.row + 2 - anchorCell.row;
        const dc = own.col + 2 - anchorCell.col;
        const len = Math.max(1, Math.abs(dr) + Math.abs(dc)); // manhattan-normalise
        const stepRow = Math.round((dr / len) * standoff);
        const stepCol = Math.round((dc / len) * standoff);
        return { row: anchorCell.row + stepRow, col: anchorCell.col + stepCol };
      }
      // Knights/archers/samurai head for the bridge crossing.
      if (bridgeSquad.has(u.id) && bridgeCell) return bridgeCell;
      if (anchor && u.id === anchor.id && s.holdRow !== null && s.holdCol !== null) {
        return { row: s.holdRow, col: s.holdCol };
      }
      // Vanguard makes a beeline for the ruins (the stage goal) even while still
      // in the castle — they're the spearhead, not gate-clearers.
      if (vanguard.has(u.id)) return { row: s.goalRow, col: s.goalCol };
      // Inside the castle → first objective is simply to clear the gate, heading
      // for the exit row at the column nearest the real goal.
      if (inOwnCastle(u.row, u.col)) {
        const col = Math.max(own.col, Math.min(own.col + 3, s.goalCol));
        return { row: exitRow, col };
      }
      // Everyone ELSE during the opening (not a runner / farmer / bridge unit):
      // do NOT pile into the ruins behind the spearhead. Form up at a RALLY point
      // partway between our castle and the ruins and hold there, ready to fight —
      // this stops the whole army trailing into the ruins ("зачем-то подтягивает
      // армию"). They only advance to the real goal once the march/assault stages
      // begin (stage !== take-ruins/sally).
      if (s.stage === 'take-ruins' || s.stage === 'sally') {
        const rallyRow = Math.round((own.row + 2 + s.goalRow) / 2);
        return { row: rallyRow, col: s.goalCol };
      }
      return { row: s.goalRow, col: s.goalCol };
    };

    // Simulated occupancy so rear units can advance into cells the front vacates.
    // Seed with every unit's current cell, plus enemies (immovable here).
    const occupied = new Set<string>();
    for (const u of this.game.board.units) {
      if (u.hp > 0) occupied.add(u.row + ',' + u.col);
    }
    const key = (r: number, c: number): string => r + ',' + c;

    // Runners: the 1-2 fastest units to reach the ruins in the opening — see
    // assignRoles() in goap.ts (Phase 2) for how `vanguard` is computed.
    const isVanguard = (u: Unit): boolean => vanguard.has(u.id);

    // Order: vanguard first (then by closeness to target), so the spearhead grabs
    // the gate and the ruins ahead of the column.
    const distToOwnTarget = (u: Unit): number => {
      const t = targetFor(u);
      return this.pathDist(u.row, u.col, t.row, t.col);
    };
    const ordered = [...myUnits].sort((a, b) => {
      const va = isVanguard(a) ? 0 : 1;
      const vb = isVanguard(b) ? 0 : 1;
      if (va !== vb) return va - vb;
      return distToOwnTarget(a) - distToOwnTarget(b);
    });

    // Units the enemy can KILL this turn — they must react (defend/escape), not
    // blindly march to the ruins under fire ("я его слишком легко мочу").
    const lethalThreatened = new Set<number>();
    for (const t of this.evaluateThreats()) {
      if (t.lethal) lethalThreatened.add(t.target.id);
    }

    const result: PlanEntry[] = [];
    for (const unit of ordered) {
      const existing = byUnit.get(unit.id);
      // Keep every non-move action verbatim — never trade a kill, a spell, a
      // weapon/armor craft, an artifact pickup or a castle-heal for a march.
      // Only plain moves (and skips) are candidates for strategic redirection.
      if (existing && existing.action.type !== 'move') {
        result.push(existing);
        continue;
      }
      // FIGHT FIRST: before any strategic march/draw, if this unit can hit an
      // adjacent enemy right now, do it. Strategy (running to ruins, farming,
      // holding the bridge) must NEVER make a unit ignore a free attack on a
      // neighbouring enemy — that's both "не бьёт соседнего врага" and the ruins-
      // defence case (a farmer attacks the intruder instead of searching).
      const atk = this.bestAttackAction(unit);
      if (atk) {
        result.push({ unitId: unit.id, action: atk });
        continue;
      }
      // SELF-PRESERVATION: if this unit can be killed this turn and has no attack
      // of its own, hand it to the full tactical scorer (escape / reposition /
      // defend) instead of marching it into death toward the ruins.
      if (lethalThreatened.has(unit.id)) {
        const scored = this.bestActionForUnit(unit);
        if (scored && scored.type !== 'skip') {
          result.push({ unitId: unit.id, action: scored });
          continue;
        }
      }
      // NOTE: the rest of the army is NOT frozen behind the runners — runners are
      // simply ordered first (they grab the gate naturally), and everyone else
      // marches the same turn so the column keeps flowing toward the ruins.
      // Ruins farmer already inside the ruins → search/level (draw an artifact)
      // instead of moving. If the search already gave it a draw/craft, that was
      // kept verbatim above; otherwise force a draw so the 3 farmers keep
      // leveling. A farmer NOT yet in the ruins falls through to movement so it
      // walks in first.
      // Farmer searches ONLY when the ruins are safe. If an enemy is near, the
      // attack check above already handled an adjacent target; here we let the
      // farmer fall through to MOVEMENT so it repositions to defend/intercept
      // instead of drawing with its back to the intruder.
      if (farmers.has(unit.id) && this.inRuins(unit.row, unit.col) && !enemyNearRuins) {
        if (unit.movesLeft >= 1) {
          result.push({ unitId: unit.id, action: { type: 'draw', score: 0 } });
        } else if (existing) {
          result.push(existing);
        }
        continue;
      }
      // The designated single ruins guard stays put (only when not using the
      // 3-farmer scheme — farmers already cover the ruins then).
      if (ruinsGuard && unit.id === ruinsGuard.id && farmers.size === 0) {
        if (existing) result.push(existing);
        continue;
      }
      const tgt = targetFor(unit);
      const curDist = this.pathDist(unit.row, unit.col, tgt.row, tgt.col);

      // TACTICAL CONTACT: an enemy is close enough that this turn's choice is
      // no longer just "which cell gets me closer to the goal" — frontal
      // attack, flanking (boxing the enemy in), and retreat are all live
      // options that trade off against each other (see bestActionForUnit's
      // attack-scoring, "Maneuver positioning", and "Fabian retreat" blocks).
      // The cheap greedy path-distance move below can't weigh those, so when
      // contact is close, defer to the full scorer instead — same escalation
      // vanguard/farmers already got, now for any unit with an enemy nearby.
      // Manhattan, not pathDist, to keep this check itself cheap: it only
      // gates whether the expensive scorer runs, not the final decision.
      const enemyInTacticalRange = enemies.some(
        (e) => manhattan(unit.row, unit.col, e.row, e.col) <= unit.maxMoves + 2,
      );
      if (enemyInTacticalRange) {
        const scored = this.bestActionForUnit(unit);
        if (scored && scored.type !== 'skip') {
          if (scored.type === 'move' && scored.row != null && scored.col != null) {
            occupied.delete(key(unit.row, unit.col));
            occupied.add(key(scored.row, scored.col));
          }
          result.push({ unitId: unit.id, action: scored });
          continue;
        }
      }

      // If the search already moves this unit FORWARD and the landing cell isn't
      // already claimed by an earlier unit this turn, honour it (update sim). The
      // occupancy check prevents two units being routed onto the same cell (which
      // would make one of them a no-op when executed sequentially).
      if (existing && existing.action.type === 'move') {
        const er = existing.action.row ?? unit.row;
        const ec = existing.action.col ?? unit.col;
        if (!occupied.has(key(er, ec)) && this.pathDist(er, ec, tgt.row, tgt.col) < curDist) {
          occupied.delete(key(unit.row, unit.col));
          occupied.add(key(er, ec));
          result.push(existing);
          continue;
        }
      }

      // This unit has no committed move worth keeping. Before redirecting it to a
      // plain march, do a CHEAP economy check (artifact pickup / weapon-armor
      // craft) the bulk would otherwise miss — the search only commits 2–3 units
      // per turn. This is deliberately light (no full bestActionForUnit scan,
      // which is ~15× too slow run for every idle unit each turn).
      const econ = this.cheapEconomyAction(unit, myUnits);
      if (econ) {
        result.push({ unitId: unit.id, action: econ });
        continue;
      }

      // Greedily pick the legal, unoccupied destination that most reduces
      // path-distance to the target. Guarantees every able unit advances each
      // turn instead of the search committing just 2–3.
      let best: { row: number; col: number; d: number } | null = null;
      for (const m of this.game.moveActionsFor(unit)) {
        if (occupied.has(key(m.row, m.col))) continue;
        const d = this.pathDist(m.row, m.col, tgt.row, tgt.col);
        if (!best || d < best.d) best = { row: m.row, col: m.col, d };
      }
      if (best && best.d < curDist) {
        occupied.delete(key(unit.row, unit.col));
        occupied.add(key(best.row, best.col));
        result.push({ unitId: unit.id, action: { type: 'move', row: best.row, col: best.col, score: 0 } });
        continue;
      }

      // Castle-egress fallback: inside the cramped 4×4 box the path-distance
      // gradient is nearly flat, so the check above finds "no progress" and the
      // rear ranks would just skip — gridlocking the whole army in the castle.
      // Instead, take any legal unoccupied move that steps toward the exit row
      // (down for a top castle, up for a bottom one). This keeps the column
      // shuffling toward the gate so cells free up rank by rank.
      if (inOwnCastle(unit.row, unit.col)) {
        const towardExit = own.row === 0
          ? (a: { row: number }, b: { row: number }) => b.row - a.row // higher row first (down)
          : (a: { row: number }, b: { row: number }) => a.row - b.row; // lower row first (up)
        const egress = this.game
          .moveActionsFor(unit)
          .filter((m) => !occupied.has(key(m.row, m.col)))
          .filter((m) => (own.row === 0 ? m.row > unit.row : m.row < unit.row))
          .sort(towardExit)[0];
        if (egress) {
          occupied.delete(key(unit.row, unit.col));
          occupied.add(key(egress.row, egress.col));
          result.push({ unitId: unit.id, action: { type: 'move', row: egress.row, col: egress.col, score: 0 } });
          continue;
        }
      }

      // No simple progress step (path-distance flat AND not a castle-egress case).
      // For the VANGUARD (runners that must punch through to the ruins) defer to
      // the full tactical scorer so they route around a blocker instead of
      // freezing. For everyone ELSE, just HOLD: a rear knight/archer with no
      // forward step should wait for the column to clear, NOT shuffle sideways or
      // backward — that pointless milling of the mass is what looked like "зачем-то
      // двигает массу". They advance next turn once a cell ahead frees up.
      // Vanguard AND farmers must reach their objective — let the full scorer
      // route them around a blocker. (A farmer still trying to walk INTO the ruins
      // shouldn't freeze just because its direct cell is taken; this is what kept
      // only one unit settling in the ruins.) The rest hold.
      if (
        isVanguard(unit) ||
        (farmers.has(unit.id) && (!this.inRuins(unit.row, unit.col) || enemyNearRuins))
      ) {
        const scored = this.bestActionForUnit(unit);
        if (scored && scored.type !== 'skip') {
          result.push({ unitId: unit.id, action: scored });
          continue;
        }
      }
      result.push({ unitId: unit.id, action: { type: 'skip', score: 0 } });
    }
    return result;
  }

  /** The best immediate attack a unit can make THIS step, or null if none is
   *  worthwhile. Used by the strategic overlay so a unit always prefers hitting an
   *  adjacent/in-range enemy over marching or farming. Prefers a kill, then the
   *  most damage; skips attacks that would land the attacker on an unsafe cell
   *  (don't throw a unit away) UNLESS the blow is lethal (a trade for a kill is
   *  fine). Returns a ready-to-execute attack AIAction. */
  private bestAttackAction(unit: Unit): AIAction | null {
    const game = this.game;
    if (unit.done || unit.movesLeft <= 0) return null;
    const actions = game.attackActionsFor(unit);
    if (!actions.length) return null;
    let best: { a: (typeof actions)[number]; score: number } | null = null;
    for (const a of actions) {
      const target = this.attackVictim(a, unit);
      if (!target) continue;
      const damage = game.computeDamage(unit, target);
      if (damage <= 0) continue;
      const lethal = damage >= target.hp;
      const safe = this.isSafePosition(a.landingRow, a.landingCol, unit);
      // Skip a non-lethal attack that leaves us exposed — that's a bad trade, not
      // a missed opportunity. A lethal blow is always worth taking.
      if (!lethal && !safe) continue;
      let score = lethal ? 30000 + this.calculateUnitValue(target) : damage * 1000;
      if (lethal && target.type === 'cavalry') score += 8000;
      if (!safe) score -= 4000; // lethal-but-exposed: still good, slightly less
      if (!best || score > best.score) best = { a, score };
    }
    if (!best) return null;
    return {
      type: 'attack',
      row: best.a.row,
      col: best.a.col,
      targetRow: best.a.targetRow,
      targetCol: best.a.targetCol,
      landingRow: best.a.landingRow,
      landingCol: best.a.landingCol,
      score: best.score,
    };
  }

  /** A unit with movement left after its first plan step keeps marching toward
   *  the stage goal (cavalry has 3 move points but generateLegalMoves only yields
   *  ONE cell per call for non-archers, so multi-step movement happens by
   *  re-selecting the unit). Returns the best next strategic step, or null to stop
   *  (no progress available) so takeStep ends the unit's turn. Only fires in the
   *  opening march stages — later, bestActionForUnit handles follow-up steps so
   *  tactics aren't bypassed. */
  private strategicFollowUp(unit: Unit): AIAction | null {
    const w = this.config.strategyWeight ?? 0;
    if (w <= 0) return null;
    const s = this.computeStrategy();
    if (s.stage !== 'sally' && s.stage !== 'take-ruins' && s.stage !== 'march') return null;
    const own = this.castleZone(this.player);
    const inCastle =
      unit.row >= own.row && unit.row < own.row + 4 && unit.col >= own.col && unit.col < own.col + 4;
    // Target: the stage goal (ruins/march); if still in the castle, the exit row.
    const exitRow = own.row === 0 ? 4 : own.row - 1;
    const tgt = inCastle
      ? { row: exitRow, col: Math.max(own.col, Math.min(own.col + 3, s.goalCol)) }
      : { row: s.goalRow, col: s.goalCol };
    const cur = this.pathDist(unit.row, unit.col, tgt.row, tgt.col);
    const curMan = Math.abs(unit.row - tgt.row) + Math.abs(unit.col - tgt.col);
    let best: { row: number; col: number; d: number; man: number } | null = null;
    for (const m of this.game.moveActionsFor(unit)) {
      const occ = this.game.board.unitAt(m.row, m.col);
      if (occ) continue;
      const d = this.pathDist(m.row, m.col, tgt.row, tgt.col);
      const man = Math.abs(m.row - tgt.row) + Math.abs(m.col - tgt.col);
      // Rank by path-distance, then by straight-line distance — so a sidestep
      // tie is broken toward the goal (prevents A↔B oscillation across steps).
      if (!best || d < best.d || (d === best.d && man < best.man)) {
        best = { row: m.row, col: m.col, d, man };
      }
    }
    if (!best) return null;
    // Take the step if it gets us strictly closer to the target...
    if (best.d < cur) return { type: 'move', row: best.row, col: best.col, score: 0 };
    // ...or, inside the castle, if it heads for the exit row (gate-egress).
    if (inCastle && (own.row === 0 ? best.row > unit.row : best.row < unit.row)) {
      return { type: 'move', row: best.row, col: best.col, score: 0 };
    }
    // ...or a SIDESTEP that doesn't increase path-distance (d <= cur) AND gets
    // closer in a straight line (man < curMan) — i.e. flows AROUND a friendly
    // unit blocking the direct line instead of freezing with full moves left
    // (the "конники стоят" bug). The manhattan condition stops A↔B oscillation.
    if (best.d <= cur && best.man < curMan && cur > 1) {
      return { type: 'move', row: best.row, col: best.col, score: 0 };
    }
    return null;
  }

  private generateUnitCombinations(units: Unit[], maxCount: number): Unit[][] {
    const combinations: Unit[][] = [];
    const count = Math.min(maxCount, units.length);
    const generate = (start: number, current: Unit[]): void => {
      if (current.length === count) {
        combinations.push([...current]);
        return;
      }
      for (let i = start; i < units.length; i += 1) {
        const u = units[i];
        if (!u) continue;
        current.push(u);
        generate(i + 1, current);
        current.pop();
      }
    };
    generate(0, []);
    return combinations;
  }

  private generatePlanForCombination(units: Unit[]): PlanEntry[] {
    const plan: PlanEntry[] = [];
    units.forEach((unit) => {
      const action = this.bestActionForUnit(unit);
      if (action && action.type !== 'skip') plan.push({ unitId: unit.id, action });
    });
    return plan;
  }

  private evaluatePlan(plan: PlanEntry[], baseEval: PositionEval): number {
    let score = 0;
    const game = this.game;
    plan.forEach((step) => {
      const unit = game.board.units.find((u: Unit) => u.id === step.unitId);
      if (!unit) return;
      const action = step.action;
      if (
        action.type === 'attack' &&
        action.targetRow !== undefined &&
        action.targetCol !== undefined
      ) {
        const target = game.board.unitAt(action.targetRow, action.targetCol);
        if (target) {
          const damage = game.computeDamage(unit, target);
          if (damage >= target.hp) {
            score += 15000;
            if (target.type === 'cavalry') score += 5000;
            if (target.type === 'archer') score += 3000;
            if (target.type === 'knight') score += 2000;
          } else {
            score += damage * 500;
          }
          if (
            action.landingRow !== undefined &&
            action.landingCol !== undefined &&
            !this.isSafePosition(action.landingRow, action.landingCol, unit)
          ) {
            score -= 8000;
          }
        }
      } else if (action.type === 'spell') {
        score += 7000;
      } else if (action.type === 'move' && action.row !== undefined && action.col !== undefined) {
        const centerDist = manhattan(action.row, action.col, ROWS >> 1, COLS >> 1);
        score += (ROWS + COLS - centerDist) * 100;
        if (game.board.isTower(action.row, action.col)) score += 5000;
        if (game.board.inRuins(action.row, action.col)) score += 2000;
      }
    });
    score += baseEval.totalScore;
    return score;
  }

  private evaluatePosition(): PositionEval {
    const game = this.game;
    const myUnits = game.ownUnits(this.player);
    const enemyUnits = game.ownUnits(otherPlayer(this.player));
    let materialScore = 0;
    let positionScore = 0;
    let threatScore = 0;
    let controlScore = 0;
    myUnits.forEach((u) => {
      materialScore += u.hp * 1000 + u.armor * 500 + u.damage * 300;
      if (u.type === 'cavalry') materialScore += 2000;
      if (u.type === 'knight') materialScore += 1000;
    });
    enemyUnits.forEach((u) => {
      materialScore -= u.hp * 1000 + u.armor * 500 + u.damage * 300;
      if (u.type === 'cavalry') materialScore -= 2000;
      if (u.type === 'knight') materialScore -= 1000;
    });
    myUnits.forEach((u) => {
      const centerDist = manhattan(u.row, u.col, ROWS >> 1, COLS >> 1);
      positionScore += (ROWS + COLS - centerDist) * 50;
      const nearestEnemy = this.findNearestEnemy(u.row, u.col);
      if (nearestEnemy) {
        const dist = manhattan(u.row, u.col, nearestEnemy.row, nearestEnemy.col);
        if (dist <= 3) positionScore += (4 - dist) * 200;
      }
      if (game.board.isTower(u.row, u.col)) positionScore += 3000;
      if (game.board.inRuins(u.row, u.col)) positionScore += 1000;
    });
    const threats = this.evaluateThreats();
    threats.forEach((t) => {
      if (t.lethal) threatScore -= 5000;
      else threatScore -= t.damage * 200;
    });
    const controlledCells = this.calculateControlledCells(myUnits);
    const enemyControlledCells = this.calculateControlledCells(enemyUnits);
    controlScore = (controlledCells - enemyControlledCells) * 100;
    const totalScore = materialScore + positionScore + threatScore + controlScore;
    return { totalScore, materialScore, positionScore, threatScore, controlScore };
  }

  private calculateControlledCells(units: Unit[]): number {
    const controlled = new Set<string>();
    units.forEach((u) => {
      const moves = this.game.moveActionsFor(u);
      const attacks = this.game.attackActionsFor(u);
      moves.forEach((m) => controlled.add(keyOf(m.row, m.col)));
      attacks.forEach((a) => controlled.add(keyOf(a.targetRow, a.targetCol)));
    });
    return controlled.size;
  }

  private findNearestEnemy(row: number, col: number): Unit | null {
    const enemies = this.game.ownUnits(otherPlayer(this.player));
    if (!enemies.length) return null;
    let nearest = enemies[0]!;
    let minDist = manhattan(row, col, nearest.row, nearest.col);
    enemies.forEach((e) => {
      const dist = manhattan(row, col, e.row, e.col);
      if (dist < minDist) {
        minDist = dist;
        nearest = e;
      }
    });
    return nearest;
  }

  private executeAction(action: AIAction | null): void {
    const game = this.game;
    if (!action) {
      game.skipSelected(true);
      return;
    }
    if (action.type === 'engine') {
      if (!action.server || !game.performEngineAction?.(action.server)) game.skipSelected(true);
      return;
    }
    if (action.type === 'attack') {
      // attackMap key = toKey(targetRow,targetCol) for shot-mode, toKey(landingRow,landingCol) for cavalry.
      // Try target position first (shot/ranged), fall back to landing position (cavalry jump).
      const tRow = action.targetRow;
      const tCol = action.targetCol;
      const lRow = action.landingRow ?? action.row;
      const lCol = action.landingCol ?? action.col;
      // Hand the game the exact attack it generated, rather than a cell to
      // look up: a pierce bolt's plan names its first cell (which may be
      // empty and is a plain move there) or its first victim, and cavalry can
      // have two attacks landing on one square.
      const sel0 = game.selectedUnit;
      const first = action.pierce?.[0];
      const exact = sel0
        ? game.attackActionsFor(sel0).find((x) =>
            x.mode === 'pierce'
              ? (first ? x.targetRow === first.row && x.targetCol === first.col : x.targetRow === tRow && x.targetCol === tCol)
              : x.targetRow === tRow &&
                x.targetCol === tCol &&
                (x.mode === 'shot' || (x.landingRow === lRow && x.landingCol === lCol)),
          )
        : undefined;
      if (exact && game.performAttack(exact.targetRow, exact.targetCol, true, exact)) {
        AIPlayer.execStats.attackOk += 1;
        return;
      }
      if (tRow !== undefined && tCol !== undefined) {
        if (game.performAttack(tRow, tCol, true)) {
          AIPlayer.execStats.attackOk += 1;
          return;
        }
      }
      if (lRow !== undefined && lCol !== undefined) {
        if (game.performAttack(lRow, lCol, true)) {
          AIPlayer.execStats.attackOk += 1;
          return;
        }
      }
      AIPlayer.execStats.attackRejected += 1;
      {
        const sel = game.selectedUnit;
        AIPlayer.execStats.log.push(
          `attack ${sel?.type ?? '?'}@${sel?.row ?? '?'},${sel?.col ?? '?'} -> target ${tRow},${tCol} land ${lRow},${lCol} (mv=${sel?.movesLeft ?? '?'})`,
        );
      }
      return;
    }
    if (action.type === 'move' && action.row !== undefined && action.col !== undefined) {
      const ok = game.performMove(action.row, action.col, true);
      // The game rejects a move it does not have in moveMap, and the action is
      // lost silently — see AIPlayer.execStats.
      AIPlayer.execStats[ok ? 'moveOk' : 'moveRejected'] += 1;
      if (!ok) {
        const sel = game.selectedUnit;
        AIPlayer.execStats.log.push(
          `move ${sel?.type ?? '?'}@${sel?.row ?? '?'},${sel?.col ?? '?'} -> ${action.row},${action.col} (mv=${sel?.movesLeft ?? '?'})`,
        );
      }
      return;
    }
    if (action.type === 'draw') {
      game.drawArtifact(true);
      return;
    }
    if (action.type === 'spell' && action.index !== undefined) {
      game.castSpell(action.index, true);
      return;
    }
    if (action.type === 'craft-armor' && action.index !== undefined) {
      game.craftArmor(action.index, true);
      return;
    }
    if (action.type === 'castle-heal') {
      // Operates on the currently-selected unit (full HP/armour restore).
      game.applyCastleHealing();
      return;
    }
    if (action.type === 'craft' && action.index !== undefined) {
      game.craftWeapon(action.index, true);
      return;
    }
    game.skipSelected(true);
  }

  private evaluateThreats(): Threat[] {
    const enemies = this.game.ownUnits(otherPlayer(this.player));
    const threats: Threat[] = [];
    enemies.forEach((enemy) => {
      const enemyAttacks = this.game.attackActionsFor(enemy);
      enemyAttacks.forEach((attack) => {
        // A pierce bolt threatens both cells of its line.
        AIPlayer.attackCells(attack).forEach((cell) => {
        const target = this.game.board.unitAt(cell.row, cell.col);
        if (target && target.player === this.player) {
          const damage = this.game.computeDamage(enemy, target);
          if (damage >= target.hp) {
            threats.push({ enemy, target, damage, lethal: true, priority: 1000 });
          } else if (damage > 0) {
            threats.push({ enemy, target, damage, lethal: false, priority: damage * 10 });
          }
        }
        });
      });
    });
    return threats.sort((a, b) => b.priority - a.priority);
  }

  /** True if a planned move/attack is still one the game offers this unit now
   *  (other entry types are validated by the game method itself). */
  private isStillLegal(unit: Unit, action: AIAction): boolean {
    if (action.type === 'move') {
      return this.game.moveActionsFor(unit).some((m) => m.row === action.row && m.col === action.col);
    }
    if (action.type === 'attack') {
      const first = action.pierce?.[0];
      return this.game.attackActionsFor(unit).some((x) =>
        x.mode === 'pierce'
          ? first
            ? x.targetRow === first.row && x.targetCol === first.col
            : x.targetRow === action.targetRow && x.targetCol === action.targetCol
          : x.targetRow === action.targetRow &&
            x.targetCol === action.targetCol &&
            (x.mode === 'shot' ||
              (x.landingRow === (action.landingRow ?? action.row) && x.landingCol === (action.landingCol ?? action.col))),
      );
    }
    return true;
  }

  /** Every cell an attack actually hits. A crossbow's pierce bolt hits its
   *  whole line; every other attack hits targetRow/targetCol only. Code that
   *  read targetRow alone missed the bolt's second cell entirely. */
  private static attackCells(a: AttackAction): Array<{ row: number; col: number }> {
    return a.mode === 'pierce' && a.targets && a.targets.length > 0
      ? a.targets
      : [{ row: a.targetRow, col: a.targetCol }];
  }

  /** True if a pierce bolt would also run through one of `player`'s units. */
  private pierceHitsOwn(a: AttackAction, player: Player): boolean {
    if (a.mode !== 'pierce') return false;
    return AIPlayer.attackCells(a).some((c) => this.game.board.unitAt(c.row, c.col)?.player === player);
  }

  /** The enemy an attack is aimed at: the first enemy on a pierce line, or the
   *  unit on the target cell. Null if it hits none (or would hit our own). */
  private attackVictim(a: AttackAction, attacker: Unit): Unit | null {
    if (this.pierceHitsOwn(a, attacker.player)) return null;
    for (const c of AIPlayer.attackCells(a)) {
      const u = this.game.board.unitAt(c.row, c.col);
      if (u && u.player !== attacker.player) return u;
    }
    return null;
  }

  private bestActionForUnit(unit: Unit): AIAction | null {
    const game = this.game;
    if (!unit || unit.done || unit.movesLeft <= 0) return { type: 'skip', score: -300 };
    const actions: AIAction[] = [];
    const enemies = game.ownUnits(otherPlayer(this.player));
    const allies = game.ownUnits(this.player);
    const threats = this.evaluateThreats();
    const isHard = this.config.useMinimax;
    // Strategic bias is computed against the unit's current cell: each candidate
    // destination is rewarded for progress toward this turn's phase/goal.
    const unitFrom = { row: unit.row, col: unit.col };
    const attackActions = game.attackActionsFor(unit);
    attackActions.forEach((a) => {
      // Pierce bolts: price the first enemy on the line, never fire through
      // one of our own units (see attackVictim).
      const target = this.attackVictim(a, unit);
      if (!target) return;
      const damage = game.computeDamage(unit, target);
      const targetValue = this.calculateUnitValue(target);
      const willBeSafe = this.isSafePosition(a.landingRow, a.landingCol, unit);
      // An enemy carrying a weapon hits markedly harder — prioritise removing it
      // (numeric damage is already reflected via computeDamage / isSafePosition;
      // this makes the AI actively *target* the armed unit rather than a soft one).
      const armedThreat = target.weapon ? 2500 + target.weapon.amount * 900 : 0;
      let score = 0;
      if (damage >= target.hp) {
        score = 30000 + targetValue;
        if (target.type === 'cavalry') score += 10000;
        if (target.type === 'archer') score += 7000;
        if (target.type === 'knight') score += 5000;
        if (target.hp < target.maxHp) score += 4000;
        if (this.focusTarget && target.id === this.focusTarget) {
          score += 10000 * this.config.focusFireWeight;
        }
        const openedOpportunities = this.analyzeOpenedOpportunities(target);
        score += openedOpportunities * 1500;
        if (!willBeSafe) {
          if (isHard) {
            const myValue = this.calculateUnitValue(unit);
            score -= targetValue > myValue * 1.2 ? 1000 : 3000;
          } else {
            score -= unit.type === 'cavalry' ? 5000 : 2500;
          }
        }
        score += this.evaluateSacrifice(unit, a);
      } else {
        score = damage * 1000;
        if (this.focusTarget && target.id === this.focusTarget) {
          score += 4000 * this.config.focusFireWeight;
        }
        if (damage >= target.armor) score += 2500;
        const canAllyFinish = this.canAllyFinishTarget(target, damage);
        if (canAllyFinish) score += 6000;
        if (damage < 2) score -= 1500;
        if (!willBeSafe) score -= isHard ? 10000 : 8000;
        else if (this.lethalApproachThreat(a.landingRow, a.landingCol, unit)) {
          score -= isHard ? 3000 : 2000;
        }
        // ── Maneuver bonuses (only meaningful when the blow isn't already a kill) ──
        // Hammer & anvil: the target is already pinned by an ally — pile on.
        const pinAllies = this.alliesAdjacentTo(target, unit.id);
        score += pinAllies * 1800;
        // Encirclement (Cannae): cut off the target's retreat so it dies next turn.
        const escapeAfter = this.freeEscapeCount(target, { row: a.landingRow, col: a.landingCol });
        if (escapeAfter <= 0) score += 5000;
        else if (escapeAfter === 1) score += 2500;
      }
      // Prioritise the armed enemy whether we kill it or just chip it.
      score += armedThreat;
      // Strategic pull: reward an attack that also advances toward the goal.
      score += this.strategyBias(a.landingRow, a.landingCol, unitFrom, unit);
      actions.push({
        type: 'attack',
        row: a.row,
        col: a.col,
        targetRow: a.targetRow,
        targetCol: a.targetCol,
        landingRow: a.landingRow,
        landingCol: a.landingCol,
        score,
      });
    });
    const myThreats = threats.filter((t) => t.target.id === unit.id);
    const seesThreats =
      this.config.threatBlindness <= 0 || Math.random() >= this.config.threatBlindness;
    const hasGoodAttack = actions.some((a) => a.score >= 25000);
    if (myThreats.length > 0 && myThreats[0]!.lethal && seesThreats && !hasGoodAttack) {
      const escapeActions = this.findEscapeRoutes(unit);
      escapeActions.forEach((escape) => {
        const escapeValue = this.evaluateCellValue(escape.row, escape.col);
        const unitImportance = this.calculateUnitValue(unit) / 5000;
        const score = 12000 + escapeValue + escape.distance * 400 + unitImportance * 2000;
        actions.push({ type: 'move', row: escape.row, col: escape.col, score });
      });
    }
    // Towers only matter to ranged units now (range bonus); with the common
    // spells gone, walking a knight onto one just wasted its activation.
    const towerHelps =
      SPELLS.length > 0 || unit.type === 'archer' || unit.type === 'crossbow' || unit.type === 'catapult';
    if (unit.movesLeft >= 1 && towerHelps) {
      for (const tower of getTowers()) {
        const occupant = game.board.unitAt(tower.row, tower.col);
        if (!occupant || occupant.player !== this.player) {
          const dist = manhattan(unit.row, unit.col, tower.row, tower.col);
          if (dist === 0) {
            if (this.config.smartSpells) this.evaluateSpellsSmart(unit, actions);
            else this.evaluateSpells(unit, actions);
          } else if (dist <= unit.movesLeft) {
            const towerValue = this.evaluateTowerCapture();
            actions.push({
              type: 'move',
              row: tower.row,
              col: tower.col,
              score: 11000 + towerValue - dist * 200,
            });
          }
        }
      }
    }
    if (game.board.isTower(unit.row, unit.col) && unit.movesLeft >= 1) {
      if (this.config.smartSpells) this.evaluateSpellsSmart(unit, actions);
      else this.evaluateSpells(unit, actions);
    }
    if (game.board.inRuins(unit.row, unit.col) && unit.movesLeft >= 1) {
      const artifactValue = this.evaluateArtifactNeed();
      actions.push({ type: 'draw', score: 3000 + artifactValue });
    }
    // Economy (anti-camp): craft a weapon (sword/bow) or armour when the recipe
    // is affordable and an eligible recipient exists, so the AI arms/armours up
    // like a ruins-camping human instead of being out-geared. The recipient test
    // uses the real canEquipWeaponToUnit (slot + type + forbid rules) so the AI
    // never crafts gear it can't actually equip. Scaled by economyWeight.
    if (unit.movesLeft >= 1 && this.config.economyWeight > 0 && !game.pendingWeaponEquip) {
      WEAPONS.forEach((w, wi) => {
        if (!game.canAfford(unit.backpack, w.recipe)) return;
        if (!game.canEquipWeaponToUnit(w, unit)) return;
        actions.push({
          type: 'craft',
          index: wi,
          score: 9000 * this.config.economyWeight + w.amount * 1500,
        });
      });
      ARMORS.forEach((a, ai) => {
        if (!game.canAfford(unit.backpack, a.recipe)) return;
        if (!game.canEquipWeaponToUnit(a, unit)) return;
        // Armour is pure defence (cuts every incoming hit) — value it close to a
        // weapon, scaled by its amount (+2 mail … +4 plate).
        actions.push({
          type: 'craft-armor',
          index: ai,
          score: 8000 * this.config.economyWeight + a.amount * 1300,
        });
      });
    }
    // Retreat-and-heal: a hurt unit standing in its OWN castle can spend its
    // turn to fully restore HP/armour. A lethal attack scores ~30000 (far above
    // this), so the AI never skips a kill to heal — but a battered unit with no
    // good attack will patch up instead of wandering.
    if (
      unit.movesLeft >= 1 &&
      game.isUnitInOwnCastle(unit) &&
      (unit.hp < unit.maxHp || unit.armor < unit.maxArmor)
    ) {
      const missingHp = unit.maxHp - unit.hp;
      const missingArmor = unit.maxArmor - unit.armor;
      let healScore = missingHp * 2600 + missingArmor * 700;
      if (threats.some((t) => t.target.id === unit.id)) healScore += 4000; // patch up before dying
      actions.push({ type: 'castle-heal', score: healScore });
    }
    const moveActions = game.moveActionsFor(unit);
    const strategicTarget = this.focusTarget
      ? (enemies.find((e) => e.id === this.focusTarget) ?? this.findStrategicTarget(unit, enemies))
      : this.findStrategicTarget(unit, enemies);
    moveActions.forEach((m) => {
      let score = 0;
      if (strategicTarget) {
        // Route AROUND mountains/rivers — real path-distance, not straight-line,
        // so the bot stops walking into a river thinking the target is "close".
        const distBefore = this.pathDist(
          unit.row,
          unit.col,
          strategicTarget.row,
          strategicTarget.col,
        );
        const distAfter = this.pathDist(m.row, m.col, strategicTarget.row, strategicTarget.col);
        const closing = distBefore - distAfter;
        score += closing * (isHard ? 600 : 400);
        if (unit.type === 'archer' && distAfter === 1) score += 3000;
        else if (unit.type !== 'archer' && distAfter === 1) score += 2500;
        else if (distAfter === 2) score += 1500;
      }
      score += this.evaluateCellValue(m.row, m.col);
      const isSafe = this.isSafePosition(m.row, m.col, unit);
      if (!isSafe) score -= isHard ? 4000 : 3000;
      else if (this.lethalApproachThreat(m.row, m.col, unit)) score -= isHard ? 3500 : 2500;
      score += this.evaluateSupportPosition(m.row, m.col, unit, allies);
      score += this.evaluateControlPosition(m.row, m.col, unit);
      if (this.config.territoryWeight > 0.5) {
        score += this.evaluatePositionalAdvantage(m.row, m.col, unit) * this.config.territoryWeight;
      }
      if (game.board.isTower(m.row, m.col)) score += 2000;
      // ── Атака на руины: гнать свободных юнитов к ближайшим руинам (экономика) ──
      // Combat (kill 30000 / backdoor 100000) dominates this, so it only steers
      // units that have nothing better to do — they go farm artifacts instead of
      // wandering, and contest the ruins so the enemy can't out-gear us.
      {
        const ruins = getAllRuins();
        if (ruins.length && this.config.economyWeight > 0) {
          let nearestCur = Infinity;
          let nearestNew = Infinity;
          for (const r of ruins) {
            const cr = r.top + Math.floor(r.height / 2);
            const cc = r.left + Math.floor(r.width / 2);
            nearestCur = Math.min(nearestCur, this.pathDist(unit.row, unit.col, cr, cc));
            nearestNew = Math.min(nearestNew, this.pathDist(m.row, m.col, cr, cc));
          }
          if (nearestNew < nearestCur) {
            score += (nearestCur - nearestNew) * Math.round(320 * this.config.economyWeight);
          }
        }
        // Standing ON a ruin (to search it next) is worth a solid pull.
        if (game.board.inRuins(m.row, m.col)) {
          score += 1400 + Math.round(this.evaluateArtifactNeed() * 0.5);
        }
      }
      // A dropped backpack — stepping here picks up its parts and auto-equips
      // any gear this unit can wear.
      for (const pack of game.droppedBackpacks ?? []) {
        if (pack.row !== m.row || pack.col !== m.col) continue;
        if (pack.weapon && game.canEquipGearForPickup({ ...pack.weapon, slot: 'weapon' }, unit)) {
          score += 1500 + pack.weapon.amount * 600;
        }
        if (pack.armorGear && game.canEquipGearForPickup({ ...pack.armorGear, slot: 'armor' }, unit)) {
          score += 1200 + pack.armorGear.amount * 600;
        }
        const partCount = Object.values(pack.parts ?? {}).reduce((a, n) => a + (n ?? 0), 0);
        score += Math.round(partCount * 250 * this.config.economyWeight);
      }
      // ── Maneuver positioning: flank / encircle an enemy by stepping adjacent ──
      // Safety is already priced in above (-3000…-4000 for unsafe cells), so these
      // bonuses only tip the AI toward boxing in enemies when it's not suicidal.
      for (const e of enemies) {
        if (manhattan(m.row, m.col, e.row, e.col) !== 1) continue;
        const pin = this.alliesAdjacentTo(e, unit.id); // anvils already in place
        if (pin >= 1) score += 900 + pin * 600; // join the hammer & anvil
        const escAfter = this.freeEscapeCount(e, { row: m.row, col: m.col });
        if (escAfter <= 0) score += 2200; // ring closed — enemy trapped
        else if (escAfter === 1) score += 1100; // ring tightening
        // Flanking a soft, dangerous backline unit is worth extra tempo.
        if (e.type === 'archer' || e.type === 'crossbow' || e.type === 'catapult') score += 600;
      }
      // ── Fabian retreat: critically damaged unit moves toward its own castle ──
      const hpFrac = unit.hp / unit.maxHp;
      if (hpFrac < 0.4) {
        const { row: ownCastleBaseRow, col: ownCastleCol } = this.castleZone(this.player);
        const castleRow = ownCastleBaseRow + 2;
        const castleCol = ownCastleCol + 2;
        const curDist = manhattan(unit.row, unit.col, castleRow, castleCol);
        const newDist = manhattan(m.row, m.col, castleRow, castleCol);
        if (newDist < curDist) {
          // Scale bonus by how critically hurt the unit is (lower HP → stronger pull).
          score += (curDist - newDist) * Math.round(600 * (0.4 - hpFrac) * 5);
        }
      }
      // ── Главные приколы: бэкдор в замок, защита своего, контр-катапульта ──
      {
        // Enemy castle 4×4 zone. Win = stand inside it while it has no defender.
        const { row: enemyRow, col: enemyCol } = this.castleZone(otherPlayer(this.player));
        const inEnemyCastle =
          m.row >= enemyRow && m.row < enemyRow + 4 && m.col >= enemyCol && m.col < enemyCol + 4;
        const enemyDefenders = enemies.filter(
          (e) =>
            e.row >= enemyRow && e.row < enemyRow + 4 && e.col >= enemyCol && e.col < enemyCol + 4,
        ).length;
        if (inEnemyCastle && enemyDefenders === 0) {
          score += 100000; // instant win — take the open door above everything else
        } else if (enemyDefenders === 0) {
          // Door is open: race a unit toward it along a terrain-aware path.
          const d = this.pathDist(m.row, m.col, enemyRow + 2, enemyCol + 2);
          score += Math.max(0, 1400 - d * 130);
        }

        // Hold our OWN door: never leave the castle undefended with the enemy near.
        const { row: ownRow, col: ownCol } = this.castleZone(this.player);
        const inOwnCastle =
          m.row >= ownRow && m.row < ownRow + 4 && m.col >= ownCol && m.col < ownCol + 4;
        const ownDefenders = allies.filter(
          (a) =>
            a.id !== unit.id &&
            a.row >= ownRow &&
            a.row < ownRow + 4 &&
            a.col >= ownCol &&
            a.col < ownCol + 4,
        ).length;
        if (
          inOwnCastle &&
          ownDefenders === 0 &&
          enemies.some((e) => this.pathDist(e.row, e.col, ownRow + 2, ownCol + 2) <= 6)
        ) {
          score += 7000; // someone MUST stay on the door when the enemy closes in
        }

        // Counter-catapult: a catapult can't fire at an adjacent cell (min range 3).
        for (const e of enemies) {
          if (e.type === 'catapult' && manhattan(m.row, m.col, e.row, e.col) === 1) score += 1800;
        }
      }
      // Strategic pull toward this turn's phase/goal.
      score += this.strategyBias(m.row, m.col, unitFrom, unit);
      actions.push({ type: 'move', row: m.row, col: m.col, score });
    });
    if (!actions.length) return { type: 'skip', score: -200 };
    if (this.config.scoreNoise > 0) {
      actions.forEach((a) => {
        a.score += (Math.random() - 0.5) * 2 * this.config.scoreNoise;
      });
    }
    actions.sort((a, b) => b.score - a.score);
    if (
      this.config.mistakeChance > 0 &&
      actions.length > 1 &&
      Math.random() < this.config.mistakeChance
    ) {
      const pick = Math.min(actions.length - 1, Math.floor(Math.random() * 3) + 1);
      return actions[pick] ?? null;
    }
    return actions[0] ?? null;
  }

  private calculateUnitValue(unit: Unit | LightUnit): number {
    let value = unit.hp * 1000 + unit.armor * 500 + unit.damage * 300;
    if (unit.type === 'cavalry') value += 3000;
    if (unit.type === 'knight') value += 2000;
    if (unit.type === 'archer') value += 1500;
    return value;
  }

  // ── Terrain-aware routing: the bot SEES mountains & rivers and walks around ──
  // Per-goal BFS distance fields, cached for the whole match (terrain is static).
  private readonly _distFields = new Map<number, Int16Array>();

  /** A mountain or river occupies (r,c) — terrain only, units are ignored (they
   *  move). board.isFree() is false for out-of-bounds, units AND terrain; strip
   *  the first two to isolate impassable terrain. */
  private terrainBlocked(r: number, c: number): boolean {
    const b = this.game.board;
    return insideBoard(r, c) && !b.unitAt(r, c) && !b.isFree(r, c);
  }

  /** BFS step-distance from every cell to (gr,gc), routing around mountains &
   *  rivers. Returns an Int16Array (−1 = walled off / unreachable). */
  private computeDistField(gr: number, gc: number): Int16Array {
    const N = ROWS; // board is square (COLS === ROWS === 20)
    const field = new Int16Array(N * N).fill(-1);
    if (!insideBoard(gr, gc)) return field;
    field[gr * N + gc] = 0;
    let frontier: number[] = [gr * N + gc];
    const DIRS = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;
    while (frontier.length) {
      const next: number[] = [];
      for (const cell of frontier) {
        const r = (cell / N) | 0;
        const c = cell % N;
        const base = field[cell];
        for (const [dr, dc] of DIRS) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= N || nc >= N) continue;
          const id = nr * N + nc;
          if (field[id] !== -1) continue; // already visited
          if (this.terrainBlocked(nr, nc)) continue; // mountains & rivers are walls
          field[id] = base + 1;
          next.push(id);
        }
      }
      frontier = next;
    }
    return field;
  }

  /** Real path-distance that goes AROUND mountains/rivers instead of through
   *  them. Falls back to manhattan when the goal is walled off (so it never
   *  under-estimates and breaks adjacency checks). */
  private pathDist(fr: number, fc: number, tr: number, tc: number): number {
    const N = ROWS;
    const goal = tr * N + tc;
    let field = this._distFields.get(goal);
    if (!field) {
      field = this.computeDistField(tr, tc);
      this._distFields.set(goal, field);
    }
    const d = field[fr * N + fc];
    return d >= 0 ? d : manhattan(fr, fc, tr, tc);
  }

  // ── Classic maneuver primitives (encirclement / flanking / hammer & anvil) ──

  /** Orthogonally adjacent, on-board cells around (row,col). */
  private orthoNeighbors(row: number, col: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as Array<[number, number]>) {
      const r = row + dr;
      const c = col + dc;
      if (insideBoard(r, c)) out.push([r, c]);
    }
    return out;
  }

  /** How many escape squares an enemy unit has (empty, passable, adjacent),
   *  optionally treating `block` as occupied (where our unit will stand). The
   *  Cannae idea: drive this to 0 and the enemy is trapped. */
  private freeEscapeCount(target: Unit, block?: { row: number; col: number }): number {
    let n = 0;
    for (const [r, c] of this.orthoNeighbors(target.row, target.col)) {
      if (block && r === block.row && c === block.col) continue;
      if (this.game.board.isFree(r, c)) n += 1;
    }
    return n;
  }

  /** Count of OUR units already adjacent to a target (excluding `excludeId`).
   *  ≥1 means the target is pinned — the "anvil" is in place for a hammer blow. */
  private alliesAdjacentTo(target: Unit, excludeId: number): number {
    let n = 0;
    for (const [r, c] of this.orthoNeighbors(target.row, target.col)) {
      const u = this.game.board.unitAt(r, c);
      if (u && u.player === this.player && u.id !== excludeId && u.alive()) n += 1;
    }
    return n;
  }

  private evaluateCellValue(row: number, col: number): number {
    let value = 0;
    const centerDist = manhattan(row, col, ROWS >> 1, COLS >> 1);
    value += (ROWS + COLS - centerDist) * 50;
    if (this.game.board.isTower(row, col)) value += 3000;
    if (this.game.board.inRuins(row, col)) value += 1000;
    return value;
  }

  private analyzeOpenedOpportunities(killedUnit: Unit): number {
    const allies = this.game.ownUnits(this.player);
    let opportunities = 0;
    allies.forEach((ally) => {
      const dist = manhattan(ally.row, ally.col, killedUnit.row, killedUnit.col);
      if (dist <= ally.maxMoves + 2) opportunities += 1;
    });
    return opportunities;
  }

  private canAllyFinishTarget(target: Unit, alreadyDamage: number): boolean {
    const allies = this.game.ownUnits(this.player);
    const remainingHp = target.hp - alreadyDamage;
    return allies.some((ally) => {
      if (ally.done) return false;
      const potentialDamage = Math.max(0, ally.damage - target.armor);
      return potentialDamage >= remainingHp;
    });
  }

  /** Weapon parts carried by the whole side. There is no shared pool any
   *  more — each unit has its own backpack — so sum them (a stub game may
   *  still hand over a legacy `inventory`). */
  private sideParts(): Record<ArtifactName, number> {
    const total: Record<ArtifactName, number> = emptyBackpack();
    const legacy = this.game.inventory?.[this.player];
    if (legacy) return Object.assign(total, legacy);
    for (const u of this.game.ownUnits(this.player)) {
      const bp = (u as Unit & { backpack?: Partial<Record<ArtifactName, number>> }).backpack;
      if (!bp) continue;
      for (const [k, n] of Object.entries(bp) as [ArtifactName, number][]) {
        if (n > 0) total[k] = (total[k] ?? 0) + n;
      }
    }
    return total;
  }

  private evaluateTowerCapture(): number {
    const inv = this.sideParts();
    let value = 0;
    SPELLS.forEach((spell) => {
      if (this.game.canAfford(inv, spell.recipe)) value += 3000;
    });
    return value;
  }

  private evaluateArtifactNeed(): number {
    const inv = this.sideParts();
    let need = 0;
    SPELLS.forEach((spell) => {
      let missing = 0;
      (Object.keys(spell.recipe) as ArtifactName[]).forEach((artifact) => {
        const required = spell.recipe[artifact] ?? 0;
        const have = inv[artifact] ?? 0;
        missing += Math.max(0, required - have);
      });
      if (missing <= 2) need += 1000;
    });
    // Also value artifacts toward WEAPON recipes (swords/bows) — anti-camp.
    WEAPONS.forEach((w) => {
      let missing = 0;
      (Object.keys(w.recipe) as ArtifactName[]).forEach((artifact) => {
        missing += Math.max(0, (w.recipe[artifact] ?? 0) - (inv[artifact] ?? 0));
      });
      if (missing <= 2) need += Math.floor(1200 * this.config.economyWeight);
    });
    return need;
  }

  private findStrategicTarget(unit: Unit, enemies: Unit[]): Unit | null {
    if (!enemies.length) return null;
    let bestTarget: Unit | null = null;
    let bestScore = -Infinity;
    enemies.forEach((enemy) => {
      const dist = manhattan(unit.row, unit.col, enemy.row, enemy.col);
      let score = (20 - dist) * 500;
      if (enemy.hp < enemy.maxHp) score += 3000 + (enemy.maxHp - enemy.hp) * 800;
      if (enemy.hp <= unit.damage) score += 5000;
      // React to gear: an ARMED enemy hits harder, so it's the dangerous piece —
      // converge on it and take it off the board first.
      if (enemy.weapon) score += 2500 + enemy.weapon.amount * 800;
      if (this.focusTarget && enemy.id === this.focusTarget) score += 8000;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = enemy;
      }
    });
    return bestTarget;
  }

  private evaluateSupportPosition(row: number, col: number, unit: Unit, allies: Unit[]): number {
    let value = 0;
    allies.forEach((ally) => {
      if (ally.id === unit.id) return;
      const dist = manhattan(row, col, ally.row, ally.col);
      if (dist >= 2 && dist <= 3) value += 200;
    });
    return value;
  }

  private evaluateControlPosition(row: number, col: number, unit: Unit): number {
    const proxy: UnitLikeForAttack = {
      type: unit.type,
      player: unit.player,
      row,
      col,
      movesLeft: unit.movesLeft,
    };
    const attacks = this.game.attackActionsFor(proxy);
    return attacks.length * 100;
  }

  private evaluateSpells(unit: Unit, actions: AIAction[]): void {
    const game = this.game;
    const allies = game.ownUnits(this.player);
    const enemies = game.ownUnits(otherPlayer(this.player));
    SPELLS.forEach((spell, index) => {
      if (!game.canAfford(this.sideParts(), spell.recipe)) return;
      let score = 0;
      if (index === 0) {
        const wounded = allies.reduce((sum, ally) => sum + Math.max(0, ally.maxHp - ally.hp), 0);
        if (wounded >= 6) score = 14000;
        else if (wounded >= 4) score = 10000;
        else if (wounded >= 2) score = 7000;
        else score = 3000;
        const enemiesNearby = enemies.filter((e) =>
          allies.some((a) => manhattan(a.row, a.col, e.row, e.col) <= 3),
        ).length;
        score += enemiesNearby * 1000;
      } else if (index === 1) {
        const needArmor = allies.reduce(
          (sum, ally) => sum + Math.max(0, ally.maxArmor - ally.armor),
          0,
        );
        const criticalArmor = allies.filter((a) => a.armor === 0 && a.maxArmor > 0).length;
        if (criticalArmor >= 3) score = 12000;
        else if (needArmor >= 5) score = 9000;
        else if (needArmor >= 3) score = 6000;
        else score = 2000;
        score += this.evaluateThreats().length * 500;
      } else if (index === 2) {
        const threats = this.evaluateThreats();
        const lethalThreats = threats.filter((t) => t.lethal).length;
        const totalThreats = threats.length;
        if (lethalThreats >= 3) score = 16000;
        else if (lethalThreats >= 2) score = 13000;
        else if (lethalThreats >= 1) score = 9000;
        else if (totalThreats >= 3) score = 6000;
        else score = 2000;
        const cavalryInDanger = threats.filter(
          (t) => t.lethal && t.target.type === 'cavalry',
        ).length;
        score += cavalryInDanger * 5000;
      }
      if (this.config.spellReluctance > 0 && Math.random() < this.config.spellReluctance) return;
      if (this.config.useMinimax && score > 0) {
        const futureValue = this.evaluateBestFutureSpell(this.sideParts(), index);
        if (futureValue > score * 1.3) score = Math.floor(score * 0.3);
      }
      if (score > 0) actions.push({ type: 'spell', index, score });
    });
  }

  private isSafePosition(row: number, col: number, unit: Unit): boolean {
    return this.isSafePositionIgnoring(row, col, unit, null);
  }

  /** isSafePosition, but treating `ignoreEnemyId` as already dead.
   *
   *  Needed by the combo check: the whole point of a combo is that the target
   *  dies this turn, so counting its retaliation makes every kill next to its
   *  own victim look like a suicide and rejects free kills outright. */
  private isSafePositionIgnoring(
    row: number,
    col: number,
    unit: Unit,
    ignoreEnemyId: number | null,
  ): boolean {
    const enemies = this.game.ownUnits(otherPlayer(this.player));
    for (const enemy of enemies) {
      if (ignoreEnemyId !== null && enemy.id === ignoreEnemyId) continue;
      const attacks = this.game.attackActionsFor(enemy);
      for (const attack of attacks) {
        if (AIPlayer.attackCells(attack).some((c) => c.row === row && c.col === col)) {
          const damage = this.game.computeDamage(enemy, unit);
          if (damage >= unit.hp) return false;
        }
      }
    }
    return true;
  }

  // Next-turn reach of an enemy (move + strike). Archer/melee both strike
  // orthogonally adjacent (range 1); reach ≈ how far it can reposition before
  // attacking with a fresh move budget.
  private enemyReach(enemy: Unit): number {
    if (enemy.type === 'cavalry') return 2; // 1 step + adjacent strike
    if (enemy.type === 'archer') return 3; // move ~2 then adjacent shot
    return 1; // knight: melee costs its whole budget — must already be adjacent
  }

  // True if enemies can converge next turn (move + attack) and kill `unit` were
  // it standing at (row,col). The point: see that the enemy can STEP UP and
  // kill, not just hit from where it stands now. Conservative (ignores blockers).
  private lethalApproachThreat(row: number, col: number, unit: Unit): boolean {
    const enemies = this.game.ownUnits(otherPlayer(this.player));
    let raw = 0;
    for (const enemy of enemies) {
      if (manhattan(enemy.row, enemy.col, row, col) <= this.enemyReach(enemy)) {
        raw += enemy.damage;
      }
    }
    if (raw <= 0) return false;
    return Math.max(0, raw - unit.armor) >= unit.hp;
  }

  private findEscapeRoutes(unit: Unit): { row: number; col: number; distance: number }[] {
    const moves = this.game.moveActionsFor(unit);
    const safe: { row: number; col: number; distance: number }[] = [];
    moves.forEach((m) => {
      if (this.isSafePosition(m.row, m.col, unit)) {
        const distFromEnemies = this.nearestEnemyDistance(m.row, m.col);
        safe.push({ row: m.row, col: m.col, distance: distFromEnemies });
      }
    });
    return safe.sort((a, b) => b.distance - a.distance);
  }

  private sortUnitsByPriority(units: Unit[]): UnitPriority[] {
    const priorities: UnitPriority[] = units.map((unit) => {
      const action = this.bestActionForUnit(unit);
      let priority = action ? action.score : 0;
      const threats = this.evaluateThreats().filter((t) => t.target.id === unit.id);
      if (threats.length > 0 && threats[0]!.lethal) priority += 9000;
      if (unit.type === 'cavalry') priority += 100;
      if (unit.type === 'archer') priority += 50;
      return { unit, action, priority };
    });
    if (this.config.skipChance > 0) {
      for (let i = priorities.length - 1; i >= 0; i -= 1) {
        if (Math.random() < this.config.skipChance && priorities.length > 1) {
          const p = priorities[i];
          if (p) {
            p.action = { type: 'skip', score: -200 };
            p.priority = -1000;
          }
        }
      }
    }
    return priorities.sort((a, b) => b.priority - a.priority);
  }

  private nearestEnemyDistance(row: number, col: number): number {
    const enemies = this.game.ownUnits(otherPlayer(this.player));
    if (!enemies.length) return 999;
    let best = Infinity;
    enemies.forEach((e) => {
      best = Math.min(best, manhattan(row, col, e.row, e.col));
    });
    return best;
  }

  private createRandomPlan(myUnits: Unit[]): PlanEntry[] {
    const game = this.game;
    const shuffled = myUnits.slice().sort(() => Math.random() - 0.5);
    const plan: PlanEntry[] = [];
    const count = Math.min(3, shuffled.length);
    for (let i = 0; i < count; i += 1) {
      const unit = shuffled[i];
      if (!unit) continue;
      const moves = game.moveActionsFor(unit);
      const attacks = game.attackActionsFor(unit);
      const all: AIAction[] = [];
      moves.forEach((m) => all.push({ type: 'move', row: m.row, col: m.col, score: 0 }));
      attacks.forEach((a) =>
        all.push({
          type: 'attack',
          row: a.row,
          col: a.col,
          targetRow: a.targetRow,
          targetCol: a.targetCol,
          landingRow: a.landingRow,
          landingCol: a.landingCol,
          score: 0,
        }),
      );
      if (all.length > 0) {
        const action = all[Math.floor(Math.random() * all.length)];
        if (action) plan.push({ unitId: unit.id, action });
      }
    }
    return plan;
  }

  private detectCombos(myUnits: Unit[]): Combo[] {
    const game = this.game;
    const enemies = game.ownUnits(otherPlayer(this.player));
    const combos: Combo[] = [];
    enemies.forEach((enemy) => {
      const attackers: ComboAttacker[] = [];
      myUnits.forEach((ally) => {
        const attacks = game.attackActionsFor(ally);
        const hits = attacks.filter(
          (a) =>
            !this.pierceHitsOwn(a, ally.player) &&
            AIPlayer.attackCells(a).some((c) => c.row === enemy.row && c.col === enemy.col),
        );
        if (hits.length > 0) {
          attackers.push({ unit: ally, damage: game.computeDamage(ally, enemy), attacks: hits });
        }
      });
      for (let i = 0; i < attackers.length; i += 1) {
        const ai = attackers[i];
        if (!ai) continue;
        if (ai.damage >= enemy.hp) {
          combos.push({
            target: enemy,
            attackers: [ai],
            totalDamage: ai.damage,
            targetValue: this.calculateUnitValue(enemy),
          });
        }
        for (let j = i + 1; j < attackers.length; j += 1) {
          const aj = attackers[j];
          if (!aj) continue;
          if (ai.damage + aj.damage >= enemy.hp) {
            combos.push({
              target: enemy,
              attackers: [ai, aj],
              totalDamage: ai.damage + aj.damage,
              targetValue: this.calculateUnitValue(enemy),
            });
          }
        }
      }
    });
    combos.sort((a, b) => b.targetValue - a.targetValue);
    return combos;
  }

  /**
   * Is this combo actually worth playing — and worth SKIPPING the search for?
   *
   * A combo commits N units to one kill and bypasses MCTS entirely, so it has
   * to clear a real bar rather than merely being possible. Charged against the
   * target's value: every attacker that ends its turn on a square the enemy can
   * kill it on is a unit we are trading away.
   *
   * Single-attacker lethal blows are the common good case (a free kill, or a
   * fair trade) and stay cheap to accept. Multi-unit combos are held to a
   * stricter standard because they cost the whole turn's activations.
   */
  private comboIsProfitable(combo: Combo): boolean {
    const targetValue = combo.targetValue;
    let risked = 0;
    let exposedCount = 0;
    for (const attacker of combo.attackers) {
      // Pick the same landing square buildComboPlan will, so the risk assessed
      // here is the risk actually taken.
      const landing =
        attacker.attacks.find((a) =>
          this.isSafePositionIgnoring(a.landingRow, a.landingCol, attacker.unit, combo.target.id),
        ) ?? attacker.attacks[0];
      if (!landing) continue;
      // The combo's target is dead by the time the opponent replies, so it does
      // not get to punish anyone — excluding it is what makes a genuinely free
      // kill register as free.
      const safe = this.isSafePositionIgnoring(
        landing.landingRow,
        landing.landingCol,
        attacker.unit,
        combo.target.id,
      );
      if (!safe) {
        risked += this.calculateUnitValue(attacker.unit);
        exposedCount += 1;
      }
    }
    // Nothing is exposed — a free kill, always take it.
    if (risked === 0) return true;
    // Never throw away more material than the target is worth.
    if (risked >= targetValue) return false;
    // A two-unit combo where BOTH attackers hang is the exact shape that lost
    // the observed game: even if the arithmetic says the trade is even, the
    // opponent gets to choose which one to take. Let the search handle it.
    if (exposedCount >= 2) return false;
    return true;
  }

  private buildComboPlan(combo: Combo, allUnits: Unit[]): PlanEntry[] {
    const plan: PlanEntry[] = [];
    const usedIds = new Set<number>();
    const ordered = combo.attackers.slice().sort((a, b) => a.damage - b.damage);
    ordered.forEach((attacker) => {
      if (usedIds.has(attacker.unit.id)) return;
      usedIds.add(attacker.unit.id);
      // Prefer a landing square the enemy cannot kill us on. This used to take
      // attacks[0] — whichever attack the generator happened to emit first —
      // so a unit with a safe approach could still be parked next to the enemy
      // army for no reason.
      const best =
        attacker.attacks.find((a) =>
          this.isSafePositionIgnoring(a.landingRow, a.landingCol, attacker.unit, combo.target.id),
        ) ?? attacker.attacks[0];
      if (!best) return;
      plan.push({
        unitId: attacker.unit.id,
        action: {
          type: 'attack',
          row: best.row,
          col: best.col,
          targetRow: best.targetRow,
          targetCol: best.targetCol,
          landingRow: best.landingRow,
          landingCol: best.landingCol,
          score: 25000,
        },
      });
    });
    if (plan.length < 3) {
      const remaining = allUnits.filter((u) => !usedIds.has(u.id));
      const scored = remaining
        .map((u) => ({ unit: u, action: this.bestActionForUnit(u) }))
        .filter(
          (s): s is { unit: Unit; action: AIAction } => !!s.action && s.action.type !== 'skip',
        )
        .sort((a, b) => (b.action.score ?? 0) - (a.action.score ?? 0));
      const first = scored[0];
      if (first) plan.push({ unitId: first.unit.id, action: first.action });
    }
    return plan;
  }

  private selectFocusTarget(): void {
    if (this.config.focusFireWeight <= 0) {
      this.focusTarget = null;
      return;
    }
    const game = this.game;
    const enemies = game.ownUnits(otherPlayer(this.player));
    if (!enemies.length) {
      this.focusTarget = null;
      return;
    }
    if (this.focusTarget) {
      const existing = enemies.find((e) => e.id === this.focusTarget);
      if (existing && existing.hp < existing.maxHp) return;
    }
    const myUnits = game.ownUnits(this.player).filter((u) => !u.done);
    const scored = enemies.map((enemy) => {
      let score = 0;
      const woundPercent = (enemy.maxHp - enemy.hp) / Math.max(1, enemy.maxHp);
      score += woundPercent * 8000;
      score += this.calculateUnitValue(enemy) * 0.5;
      let potDmg = 0;
      let attackerCount = 0;
      myUnits.forEach((ally) => {
        const attacks = game.attackActionsFor(ally);
        if (
          attacks.some(
            (a) =>
              !this.pierceHitsOwn(a, ally.player) &&
              AIPlayer.attackCells(a).some((c) => c.row === enemy.row && c.col === enemy.col),
          )
        ) {
          potDmg += game.computeDamage(ally, enemy);
          attackerCount += 1;
        }
      });
      if (potDmg >= enemy.hp) score += 15000;
      if (attackerCount >= 2) score += 5000;
      const avgDist =
        myUnits.reduce((s, a) => s + manhattan(a.row, a.col, enemy.row, enemy.col), 0) /
        Math.max(1, myUnits.length);
      score += (20 - avgDist) * 300;
      const nearbyAllies = enemies.filter(
        (e) => e.id !== enemy.id && manhattan(e.row, e.col, enemy.row, enemy.col) <= 3,
      );
      if (nearbyAllies.length === 0) score += 3000;
      return { id: enemy.id, score };
    });
    scored.sort((a, b) => b.score - a.score);
    this.focusTarget = scored[0] ? scored[0].id : null;
  }

  private createSequentialPlan(myUnits: Unit[]): PlanEntry[] {
    const game = this.game;
    const count = Math.min(3, myUnits.length);
    const scored = myUnits
      .map((u) => {
        let score = 0;
        const attacks = game.attackActionsFor(u);
        attacks.forEach((a) => {
          const target = this.attackVictim(a, u);
          if (target && target.player !== this.player) {
            const dmg = game.computeDamage(u, target);
            if (dmg >= target.hp) score += 15000;
            else score += dmg * 500;
          }
        });
        if (this.focusTarget) {
          const enemies = game.ownUnits(otherPlayer(this.player));
          const ft = enemies.find((e) => e.id === this.focusTarget);
          if (ft) {
            const dist = manhattan(u.row, u.col, ft.row, ft.col);
            if (dist <= 3) score += 5000 - dist * 500;
          }
        }
        return { unit: u, score };
      })
      .sort((a, b) => b.score - a.score);
    const topCandidates = scored.slice(0, Math.min(6, myUnits.length)).map((s) => s.unit);
    const perms = this.getPermutations(topCandidates, count);
    let bestPlan: PlanEntry[] = [];
    let bestScore = -Infinity;
    for (const perm of perms) {
      let simState = this.createLightState();
      const plan: PlanEntry[] = [];
      let actionScore = 0;
      for (const unit of perm) {
        const simUnit = simState.units.find((u) => u.id === unit.id);
        if (!simUnit || simUnit.hp <= 0 || simUnit.done) continue;
        const action = this.bestActionForSimState(simState, simUnit);
        if (action && action.type !== 'skip') {
          plan.push({ unitId: unit.id, action });
          simState = this.applyActionToState(simState, unit.id, action);
          actionScore += action.score ?? 0;
        }
      }
      const stateScore = this.evaluateLightState(simState);
      const finalScore = actionScore + stateScore;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestPlan = plan;
      }
    }
    return bestPlan;
  }

  private getPermutations(arr: Unit[], count: number): Unit[][] {
    const result: Unit[][] = [];
    if (count <= 0 || arr.length === 0) return result;
    const used = new Array(arr.length).fill(false);
    const build = (current: Unit[]): void => {
      if (current.length === count) {
        result.push(current.slice());
        return;
      }
      for (let i = 0; i < arr.length; i += 1) {
        if (used[i]) continue;
        used[i] = true;
        const u = arr[i];
        if (u) current.push(u);
        build(current);
        current.pop();
        used[i] = false;
      }
    };
    build([]);
    return result;
  }

  private bestActionForSimState(
    state: LightState,
    simUnit: LightUnit,
    perspective: Player = this.player,
  ): AIAction | null {
    const me = perspective;
    const isOwnPerspective = perspective === this.player;
    const enemies = state.units.filter((u) => u.player !== me && u.hp > 0);
    if (!enemies.length) return { type: 'skip', score: -200 };
    // Danger at the unit's current square — constant across candidates, so it is
    // computed once and used to price moves RELATIVE to standing still.
    const diesHereReal = !this.isSimPositionSafe(state, simUnit.row, simUnit.col, simUnit, null);
    const actions: AIAction[] = [];
    const rawActions = this.generateActionsForLightState(state, simUnit);
    for (const raw of rawActions) {
      if (raw.type === 'skip') continue;
      if (raw.type === 'attack' && raw.targetRow !== undefined && raw.targetCol !== undefined) {
        const target = state.units.find(
          (u) => u.row === raw.targetRow && u.col === raw.targetCol && u.player !== me && u.hp > 0,
        );
        if (!target) continue;
        let dmg = simUnit.damage;
        if (state.damageBuff[simUnit.player] > 0) dmg += 2;
        dmg = Math.max(0, dmg - target.armor);
        if (state.shieldTurns[target.player] > 0) dmg = Math.max(0, dmg - 2);
        let score = 0;
        const lr = raw.landingRow !== undefined ? raw.landingRow : simUnit.row;
        const lc = raw.landingCol !== undefined ? raw.landingCol : simUnit.col;
        if (dmg >= target.hp) {
          score = 25000 + target.hp * 1000 + target.damage * 500;
          if (target.type === 'cavalry') score += 8000;
          if (target.type === 'archer') score += 6000;
          if (target.type === 'knight') score += 4000;
          if (isOwnPerspective && this.focusTarget && target.id === this.focusTarget) score += 5000;
          if (target.hp < target.maxHp) score += 3000;
          // E: tactical pattern — archer kill is a kite (no landing position
          // change, attack-in-place); reward favorable distance after.
          if (simUnit.type === 'archer' && this.config.archerKiteWeight > 0) {
            score += 800 * this.config.archerKiteWeight;
          }
          // E: cavalry L-flank — extra reward for jump-kill that opens flank.
          if (simUnit.type === 'cavalry' && this.config.cavalryFlankWeight > 0) {
            const lFlank = manhattan(lr, lc, target.row, target.col) >= 2;
            if (lFlank) score += 1200 * this.config.cavalryFlankWeight;
          }
          const landingSafe = this.isSimPositionSafe(state, lr, lc, simUnit, target.id);
          if (!landingSafe) {
            // B: trade calculus — penalise bad trades (lose more than gain).
            // Good trades (kill expensive unit with cheaper one) stay attractive.
            const myVal = this.simUnitValue(simUnit);
            const targetVal = this.simUnitValue(target);
            const tradeDeficit = Math.max(0, myVal - targetVal);
            score -= Math.min(14000, 3000 + tradeDeficit * 0.4);
          }
        } else if (dmg > 0) {
          score = dmg * 800;
          if (target.armor > 0 && dmg >= target.armor) score += 2000;
          if (isOwnPerspective && this.focusTarget && target.id === this.focusTarget) score += 3000;
          const remainHp = target.hp - dmg;
          const allies = state.units.filter(
            (u) => u.player === me && u.id !== simUnit.id && u.hp > 0 && !u.done && u.movesLeft > 0,
          );
          let canFinish = false;
          for (const a of allies) {
            const dist = manhattan(a.row, a.col, target.row, target.col);
            const allyDmg = Math.max(0, a.damage - Math.max(0, target.armor - dmg));
            if (a.type === 'archer' && dist === 1 && allyDmg >= remainHp) {
              canFinish = true;
              break;
            }
            if (a.type !== 'archer' && dist <= 2 && allyDmg >= remainHp) {
              canFinish = true;
              break;
            }
          }
          if (canFinish) score += 5000;
          const landingSafe = this.isSimPositionSafe(state, lr, lc, simUnit, null);
          // If already unsafe (unit is exposed regardless), attacking is better
          // than moving into range and doing nothing. Floor ensures attack > skip.
          if (!landingSafe) score = Math.max(dmg * 300, score - 3500);
        }
        actions.push({
          type: 'attack',
          row: raw.row,
          col: raw.col,
          targetRow: raw.targetRow,
          targetCol: raw.targetCol,
          landingRow: lr,
          landingCol: lc,
          cost: raw.cost,
          score,
        });
      } else if (raw.type === 'move' && raw.row !== undefined && raw.col !== undefined) {
        let score = 0;
        let bestEnemyDist = Infinity;
        let currentBestDist = Infinity;
        enemies.forEach((e) => {
          const newDist = manhattan(raw.row!, raw.col!, e.row, e.col);
          const curDist = manhattan(simUnit.row, simUnit.col, e.row, e.col);
          if (newDist < bestEnemyDist) bestEnemyDist = newDist;
          if (curDist < currentBestDist) currentBestDist = curDist;
        });
        score += (currentBestDist - bestEnemyDist) * 400;
        if (simUnit.type === 'archer' || simUnit.type === 'crossbow') {
          // A shooter wants to be IN range, not in contact. Its square zone is
          // Chebyshev-2, so manhattan 2-3 keeps the target under fire while
          // staying off the enemy's melee square. Walking to distance 1 throws
          // away the whole point of a ranged unit and invites retaliation —
          // this used to award +2500 for exactly that, which is why archers
          // marched onto the cell next to a horse instead of shooting it.
          if (bestEnemyDist === 2) score += 2500;
          else if (bestEnemyDist === 3) score += 1500;
          else if (bestEnemyDist === 1) score -= 1200;
        } else {
          if (bestEnemyDist === 1) score += 2000;
          if (bestEnemyDist === 2) score += 1200;
        }
        if (isOwnPerspective && this.focusTarget) {
          const ft = enemies.find((e) => e.id === this.focusTarget);
          if (ft) {
            const ftDistNew = manhattan(raw.row, raw.col, ft.row, ft.col);
            const ftDistCur = manhattan(simUnit.row, simUnit.col, ft.row, ft.col);
            score += (ftDistCur - ftDistNew) * 500;
          }
        }
        // C: castle approach — bonus for advancing toward the ENEMY castle.
        // The target row comes from the real castle layout (see enemyCastleRow);
        // the eval also covers this at leaf level, but a per-move signal helps
        // shape the search inside a turn.
        if (this.config.castleApproachWeight > 0) {
          const backRank = this.enemyCastleRow(me);
          const distCur = Math.abs(simUnit.row - backRank);
          const distNew = Math.abs(raw.row - backRank);
          score += (distCur - distNew) * 250 * this.config.castleApproachWeight;
        }
        // E: knight tank — bonus for moves that put a knight adjacent to an
        // ally archer/cavalry (shielding role).
        if (simUnit.type === 'knight' && this.config.knightTankWeight > 0) {
          const ranged = state.units.filter(
            (u) =>
              u.player === me &&
              u.hp > 0 &&
              u.id !== simUnit.id &&
              (u.type === 'archer' || u.type === 'cavalry'),
          );
          for (const a of ranged) {
            if (manhattan(raw.row, raw.col, a.row, a.col) === 1) {
              score += 700 * this.config.knightTankWeight;
              break;
            }
          }
        }
        // E: archer kite — bonus for an archer move that keeps an enemy inside
        // the shooting square while staying off the enemy's melee square.
        // Shot range is Chebyshev-2, so "in range but not in contact" is
        // manhattan 2-3; requiring dist === 1 (as this did) rewarded the exact
        // square the archer should avoid.
        if (
          (simUnit.type === 'archer' || simUnit.type === 'crossbow') &&
          this.config.archerKiteWeight > 0
        ) {
          const huggers = state.units.filter(
            (u) => u.player !== me && u.hp > 0 && u.type !== 'archer',
          );
          let minMeleeDist = 99;
          for (const h of huggers) {
            minMeleeDist = Math.min(minMeleeDist, manhattan(raw.row, raw.col, h.row, h.col));
          }
          if (bestEnemyDist >= 2 && bestEnemyDist <= 3 && minMeleeDist >= 2) {
            score += 1500 * this.config.archerKiteWeight;
          }
        }
        if (getTowers().some((t) => t.row === raw.row && t.col === raw.col)) score += 2500;
        const rRow = raw.row ?? -1;
        const rCol = raw.col ?? -1;
        if (
          getAllRuins().some(
            (r) =>
              rRow >= r.top && rRow < r.top + r.height && rCol >= r.left && rCol < r.left + r.width,
          )
        ) {
          score += 800;
        }
        // Relative to the unit's current square, matching the light scorer: a
        // flat penalty cancels out once the unit is already in a hot zone (every
        // square it can reach is "unsafe"), which leaves the distance term to
        // pick the square NEAREST the enemy.
        const diesThere = !this.isSimPositionSafe(state, raw.row, raw.col, simUnit, null);
        if (diesThere && !diesHereReal) score -= 3500;
        else if (!diesThere && diesHereReal) score += 3500;
        actions.push({
          type: 'move',
          row: raw.row,
          col: raw.col,
          cost: raw.cost,
          score,
        });
      }
    }
    if (!actions.length) return { type: 'skip', score: -200 };
    actions.sort((a, b) => b.score - a.score);
    return actions[0] ?? null;
  }

  private isSimPositionSafe(
    state: LightState,
    row: number,
    col: number,
    unit: LightUnit,
    excludeEnemyId: number | null,
  ): boolean {
    return this.simThreatAt(state, row, col, unit, excludeEnemyId) < unit.hp;
  }

  /**
   * Total damage the enemy could land on `unit` if it stood at (row,col) —
   * summed over every enemy that can reach it, so 2v1 pile-ons are counted.
   *
   * Graded, unlike `isSimPositionSafe`. A binary safe/unsafe flag cannot rank
   * retreats: once a unit is in a hot zone EVERY square it can reach is
   * "unsafe", the same penalty applies to all of them, and the tie falls
   * through to the raw distance term — which prefers the square CLOSEST to the
   * enemy. That is exactly how archers ended up standing still and dying.
   */
  private simThreatAt(
    state: LightState,
    row: number,
    col: number,
    unit: LightUnit,
    excludeEnemyId: number | null,
  ): number {
    // Hot path: called once per candidate action per rollout (millions of times
    // per turn). Iterate in place — the previous `.filter()` allocated a fresh
    // array on every call and measurably halved search throughput.
    const units = state.units;
    const shielded = state.shieldTurns[unit.player] > 0;
    let totalThreat = 0;
    for (let i = 0; i < units.length; i += 1) {
      const enemy = units[i]!;
      if (enemy.player === unit.player || enemy.hp <= 0 || enemy.id === excludeEnemyId) continue;
      if (!this.simEnemyCanReach(enemy, row, col)) continue;
      let dmg = enemy.damage;
      if (state.damageBuff[enemy.player] > 0) dmg += 2;
      dmg -= unit.armor;
      if (shielded) dmg -= 2;
      if (dmg > 0) totalThreat += dmg;
    }
    return totalThreat;
  }

  /**
   * Can `enemy` hit the square (row,col) on ITS next turn, accounting for the
   * fact that it may MOVE first and then attack?
   *
   * The previous version compared only the enemy's CURRENT distance against its
   * attack range (melee `dist <= 1`), which declared a square "safe" whenever no
   * enemy was already standing next to it. That is wrong for every mobile unit:
   * a 3-move cavalry two cells away kills anything it likes. It is why the bot
   * left archers hanging — no retreat looked any safer than standing still, so
   * the raw distance term picked the square nearest the enemy.
   *
   * Reach = (squares it can step through) + (its attack range from there).
   * Movement is approximated with Manhattan distance, ignoring terrain and
   * blockers, so this deliberately OVER-estimates danger: for a safety check,
   * a false "unsafe" costs a little tempo while a false "safe" loses the unit.
   */
  private simEnemyCanReach(enemy: LightUnit, row: number, col: number): boolean {
    // DEFAULT: "can it hit this square from where it stands right now".
    //
    // This deliberately UNDER-estimates danger — it ignores that a unit moves
    // before it attacks. The accurate move-then-attack envelope is implemented
    // below and is strictly more correct, but it measured much WEAKER in real
    // games: on the fixed-opponent gauntlet (scripts/ai-gauntlet.ts, 6 games
    // each) the conservative model scores 18/18 = 100%, the accurate one
    // 10/18 = 55.6% — losing half its games to a castle rush and drawing
    // against a kiter it used to beat.
    //
    // Why: marking every square an enemy could reach as unsafe makes almost the
    // whole board unsafe once armies are in contact. The penalty then applies
    // everywhere, stops discriminating, and the bot turns passive — it will not
    // contest ground, so it stops trading, stops pushing, and runs the clock
    // out. An under-estimate that stays SPARSE is a more useful signal than an
    // over-estimate that is always on.
    //
    // Set `accurateThreatModel` to opt into the precise envelope.
    if (!this.config.accurateThreatModel) {
      const d = manhattan(enemy.row, enemy.col, row, col);
      return enemy.type === 'archer' || enemy.type === 'crossbow'
        ? d <= 2
        : enemy.type === 'catapult'
          ? d >= 3 && d <= 6
          : d <= 1;
    }
    const moves = enemy.movesLeft > 0 ? enemy.movesLeft : enemy.maxMoves;

    // Cheap rejection before the per-type work. Nothing reaches further than
    // its move budget plus its maximum attack range (catapult's 6 is the
    // largest), so anything beyond that is safe without further arithmetic.
    const dr = enemy.row - row;
    const dc = enemy.col - col;
    const adr = dr < 0 ? -dr : dr;
    const adc = dc < 0 ? -dc : dc;
    if (adr + adc > moves + CATAPULT_MAX_RANGE) return false;

    if (enemy.type === 'archer' || enemy.type === 'crossbow') {
      // Shot range is a Chebyshev square, and each step of range costs a move,
      // so a shooter must split its budget between walking and shooting.
      // Cheapest shot costs 1, leaving `moves - 1` steps of approach.
      const step = moves > 1 ? moves - 1 : 0;
      return (adr > adc ? adr : adc) <= ARCHER_SQUARE_RADIUS + step;
    }

    if (enemy.type === 'catapult') {
      // Bombardment is a Manhattan annulus (3–6) that costs 1 move. Moving
      // widens the outer edge but also lets it close the inner hole, so any
      // square within maxRange + remaining steps is threatened.
      const step = moves > 1 ? moves - 1 : 0;
      const dist = adr + adc;
      return dist >= CATAPULT_MIN_RANGE - step && dist <= CATAPULT_MAX_RANGE + step;
    }

    // Melee (knight/samurai/cavalry): walk, then strike an adjacent square.
    // Cavalry's jump attack costs 2 moves but also reaches 2 cells, so the same
    // walk-then-hit envelope bounds it.
    return adr + adc <= moves + 1;
  }

  /**
   * True when `player`'s own castle is undefended and an enemy is close enough
   * to walk into it. Used to suppress luxuries (ruins farming, crafting) while
   * the game is being lost behind the front line.
   */
  private homeIsThreatened(state: LightState, player: Player): boolean {
    const home = this.castleZone(player);
    const homeRow = home.row + 2;
    const homeCol = home.col + 2;
    let defended = false;
    let nearestEnemy = Infinity;
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      if (u.player === player) {
        if (!defended && this.inCastleZone(u.row, u.col, player)) defended = true;
      } else {
        const d = manhattan(u.row, u.col, homeRow, homeCol);
        if (d < nearestEnemy) nearestEnemy = d;
      }
    }
    return !defended && nearestEnemy <= 8;
  }

  /** Material value of a light unit — used for trade calculus. */
  /** The single definition of "what is this unit worth". Shared by the threat,
   *  hanging-piece and trade terms so they cannot drift apart — they used to
   *  each inline their own copy of this formula with different armor weights. */
  private simUnitValue(u: LightUnit): number {
    return (
      u.hp * W.material.perHp +
      u.armor * W.material.perArmor +
      u.damage * W.material.perDamage +
      (W.material.byType[u.type] ?? W.material.byType.archer)
    );
  }

  private createLightState(): LightState {
    const game = this.game;
    return {
      units: game.board.units
        .filter((u) => u.alive())
        .map((u) => ({
          id: u.id,
          player: u.player,
          type: u.type,
          row: u.row,
          col: u.col,
          hp: u.hp,
          armor: u.armor,
          damage: u.damage,
          maxMoves: u.maxMoves,
          movesLeft: u.movesLeft,
          done: u.done,
          maxHp: u.maxHp,
          maxArmor: u.maxArmor,
          activated: (u as Unit & { activated?: boolean }).activated === true,
          wardedBy: u.wardedBy ?? null,
          facing: u.facing,
          ...(u.type === 'mage' ? { energy: u.energy } : {}),
        })),
      shieldTurns: { 1: game.shieldTurns[1], 2: game.shieldTurns[2] },
      damageBuff: { 1: game.damageBuff[1], 2: game.damageBuff[2] },
      activationsLeft: this.activationBudget(),
      inventory: this.sideParts(),
    };
  }

  /** Activation slots still available to the side to move. Falls back to a
   *  large number when the game doesn't report a cap, so a stub game (tests,
   *  the worker) behaves as it did before this limit was modelled. */
  private activationBudget(): number {
    const max = this.game.maxActivatedPerTurn;
    if (typeof max !== 'number') return Number.MAX_SAFE_INTEGER;
    const used = this.game.activatedCount ?? 0;
    return Math.max(0, max - used);
  }

  /** A full turn's activation cap (used when a simulated turn rolls over). */
  private turnActivationCap(): number {
    const max = this.game.maxActivatedPerTurn;
    return typeof max === 'number' ? max : Number.MAX_SAFE_INTEGER;
  }

  private cloneLightState(state: LightState): LightState {
    return {
      units: state.units.map((u) => ({ ...u })),
      shieldTurns: { 1: state.shieldTurns[1], 2: state.shieldTurns[2] },
      damageBuff: { 1: state.damageBuff[1], 2: state.damageBuff[2] },
      activationsLeft: state.activationsLeft,
      inventory: { ...state.inventory },
    };
  }

  /** Resolve one hit of `attacker` on `target` inside a light state: mage ward
   *  first (same rule as apply.ts absorbWithWard — fully absorbed, the warding
   *  mage pays the raw damage in energy or dies), otherwise armour-reduced
   *  damage. Without the ward the search "killed" shielded units every rollout. */
  private lightHit(ns: LightState, attacker: LightUnit, target: LightUnit): void {
    const wardMage = target.wardedBy
      ? ns.units.find((u) => u.id === target.wardedBy && u.type === 'mage' && u.hp > 0)
      : undefined;
    if (wardMage) {
      const raw = attacker.damage;
      if ((wardMage.energy ?? 0) >= raw) {
        wardMage.energy = (wardMage.energy ?? 0) - raw;
      } else {
        wardMage.hp = 0;
        ns.units = ns.units.filter((u) => u.id !== wardMage.id);
        for (const u of ns.units) if (u.wardedBy === wardMage.id) u.wardedBy = null;
      }
      return;
    }
    // Ranged units firing from a tower trade damage for range (combat.ts).
    let raw = attacker.damage;
    if (
      (attacker.type === 'archer' || attacker.type === 'crossbow' || attacker.type === 'catapult') &&
      AIPlayer.isTowerCell(attacker.row, attacker.col)
    ) {
      raw = Math.max(1, Math.round(raw * TOWER_DAMAGE_FACTOR));
    }
    raw = applyFacingDamage(raw, target, attacker.row, attacker.col); // back ×2, side ×1.25
    let dmg = Math.max(0, raw - target.armor);
    if (ns.shieldTurns[target.player] > 0) dmg = Math.max(0, dmg - 2);
    target.hp -= dmg;
    if (target.hp <= 0) {
      ns.units = ns.units.filter((u) => u.id !== target.id);
      if (target.type === 'mage') {
        for (const u of ns.units) if (u.wardedBy === target.id) u.wardedBy = null;
      }
    }
  }

  private applyActionToState(state: LightState, unitId: number, action: AIAction): LightState {
    const ns = this.cloneLightState(state);
    const unit = ns.units.find((u) => u.id === unitId);
    if (!unit) return ns;
    // Acting with a unit for the first time this turn spends an activation
    // slot, exactly as game.selectUnit() does. Acting again with an already
    // activated unit is free.
    if (!unit.activated) {
      unit.activated = true;
      ns.activationsLeft = Math.max(0, ns.activationsLeft - 1);
    }
    if (action.type === 'move' && action.row !== undefined && action.col !== undefined) {
      unit.facing = facingToward(unit.row, unit.col, action.row, action.col, facingOf(unit));
      unit.row = action.row;
      unit.col = action.col;
      unit.movesLeft -= action.cost ?? 1;
    } else if (action.type === 'attack' && action.pierce && action.pierce.length > 0) {
      // Pierce: every living unit on the line takes the hit, friend or foe,
      // with the same ward rule as a single-target hit.
      for (const cell of action.pierce) {
        const victim = ns.units.find((u) => u.row === cell.row && u.col === cell.col && u.hp > 0);
        if (victim) this.lightHit(ns, unit, victim);
      }
      unit.movesLeft -= action.cost ?? CROSSBOW_PIERCE_COST;
    } else if (
      action.type === 'attack' &&
      action.targetRow !== undefined &&
      action.targetCol !== undefined
    ) {
      const target = ns.units.find(
        (u) =>
          u.row === action.targetRow &&
          u.col === action.targetCol &&
          u.player !== unit.player &&
          u.hp > 0,
      );
      if (target) {
        const turned = turnCost(unit, target.row, target.col) > 0;
        this.lightHit(ns, unit, target);
        if (action.landingRow !== undefined && action.landingCol !== undefined) {
          unit.row = action.landingRow;
          unit.col = action.landingCol;
        }
        if (turned || unit.row !== action.row || unit.col !== action.col) {
          unit.facing = facingToward(unit.row, unit.col, target.row, target.col, facingOf(unit));
        }
      }
      unit.movesLeft -= action.cost ?? 2;
    } else if (action.type === 'spell' && action.index !== undefined) {
      // Mirrors the three SPELLS in game-rules constants: heal, armour restore,
      // and the +2 damage buff. Artifacts are deducted so the search cannot
      // "cast" the same spell every turn for free.
      const spell = SPELLS[action.index];
      if (spell) {
        for (const art of Object.keys(spell.recipe) as ArtifactName[]) {
          const have = ns.inventory[art] ?? 0;
          ns.inventory[art] = Math.max(0, have - (spell.recipe[art] ?? 0));
        }
        const allies = ns.units.filter((u) => u.player === unit.player && u.hp > 0);
        if (action.index === 0) {
          for (const a of allies) a.hp = Math.min(a.maxHp, a.hp + 2);
        } else if (action.index === 1) {
          for (const a of allies) a.armor = Math.min(a.maxArmor, a.armor + 2);
        } else if (action.index === 2) {
          ns.damageBuff[unit.player] = 2;
        }
      }
      unit.movesLeft -= action.cost ?? 1;
    } else if (action.type === 'craft' && action.index !== undefined) {
      // Crafting consumes the recipe. The weapon goes to a pending-equip slot in
      // the real game; the light state only models the artifact spend and the
      // tempo, so the search stops treating crafting as free.
      const weapon = WEAPONS[action.index];
      if (weapon) {
        for (const art of Object.keys(weapon.recipe) as ArtifactName[]) {
          const have = ns.inventory[art] ?? 0;
          ns.inventory[art] = Math.max(0, have - (weapon.recipe[art] ?? 0));
        }
      }
      unit.movesLeft -= action.cost ?? 1;
    } else if (action.type === 'draw') {
      // Searching ruins consumes the unit's entire remaining turn. The loot
      // itself is random, so the light state cannot model the reward — only the
      // tempo cost. Scoring credits the expected value (see scoreLightActions).
      unit.movesLeft = 0;
      unit.done = true;
    } else if (action.type === 'skip') {
      unit.done = true;
    }
    if (unit.movesLeft <= 0) unit.done = true;
    return ns;
  }

  /** The row a player must advance TOWARD to reach the enemy castle.
   *
   *  Derived from castleZone rather than hard-coded, because which side of the
   *  board a player starts on depends on `player1Bottom`. The per-move castle
   *  approach heuristic previously hard-coded `me === 1 ? 19 : 0`, which is the
   *  player's OWN back rank under the default layout — so it rewarded retreating
   *  and penalised advancing, and the search never even expanded a winning step
   *  into the enemy castle (the leaf evaluation scored that position at +300k,
   *  but the move that reached it was ranked below shuffling backwards). */
  private enemyCastleRow(me: Player): number {
    const { row } = this.castleZone(otherPlayer(me));
    return row + 2; // centre of the 4×4 zone
  }

  /** Returns { row, col } of the top-left corner of a player's own castle (4×4 zone). */
  private castleZone(player: Player): { row: number; col: number } {
    const p1Bottom = this.game.player1Bottom;
    const col = player === 1 ? getCastleP1Col() : getCastleP2Col();
    const row = player === 1 ? (p1Bottom ? 16 : 0) : p1Bottom ? 0 : 16;
    return { row, col };
  }

  private inCastleZone(unitRow: number, unitCol: number, owner: Player): boolean {
    const { row, col } = this.castleZone(owner);
    return unitRow >= row && unitRow < row + 4 && unitCol >= col && unitCol < col + 4;
  }

  private evaluateLightState(state: LightState, perspective: Player = this.player): number {
    const me = perspective;
    const opp: Player = me === 1 ? 2 : 1;
    let score = 0;
    let myCount = 0;
    let oppCount = 0;
    const myUnits: LightUnit[] = [];
    const oppUnits: LightUnit[] = [];
    state.units.forEach((u) => {
      if (u.hp <= 0) return;
      if (u.player === me) {
        myUnits.push(u);
        myCount += 1;
      } else {
        oppUnits.push(u);
        oppCount += 1;
      }
      const sign = u.player === me ? 1 : -1;
      score +=
        sign * (u.hp * W.material.perHp + u.armor * W.material.perArmor + u.damage * W.material.perDamage);
      score += sign * (W.material.byType[u.type] ?? W.material.byType.archer);
      if (getTowers().some((t) => t.row === u.row && t.col === u.col))
        score += sign * W.material.onTower;
    });
    score += (myCount - oppCount) * W.material.presence;
    if (myCount === 0) score -= W.material.wipeout;
    if (oppCount === 0) score += W.material.wipeout;

    // ── GOAL 1: Castle capture — near-win signal ─────────────────────────────
    // If any of my units is inside the enemy castle AND no enemy defends their
    // own castle, that's a winning position — give it a massive bonus so MCTS
    // rollouts recognise "enter their castle" as the primary objective.
    const myUnitInEnemyCastle = myUnits.some((u) => this.inCastleZone(u.row, u.col, opp));
    const oppDefendingOwnCastle = oppUnits.some((u) => this.inCastleZone(u.row, u.col, opp));
    if (myUnitInEnemyCastle && !oppDefendingOwnCastle) score += W.castle.captureUndefended;
    else if (myUnitInEnemyCastle) score += W.castle.captureDefended; // inside but defended — still good

    // ── GOAL 2: Castle defense — threat signal ───────────────────────────────
    // If an enemy unit is inside MY castle and I have no defender there,
    // that's near-loss. Apply a heavy penalty so the AI retreats a defender.
    const oppInMyCastle = oppUnits.some((u) => this.inCastleZone(u.row, u.col, me));
    const myDefendingOwnCastle = myUnits.some((u) => this.inCastleZone(u.row, u.col, me));
    if (oppInMyCastle && !myDefendingOwnCastle) score -= W.castle.lossUndefended;
    else if (oppInMyCastle) score -= W.castle.lossDefended;

    // ── GOAL 2b: Anticipate the raid ────────────────────────────────────────
    // The check above only fires once an enemy is ALREADY standing in the
    // castle — but capture resolves the moment that happens, so by then the
    // game is lost and there is nothing left to retreat to. Nothing priced the
    // danger of an EMPTY castle with a raider closing in, so the bot happily
    // marched all ten units forward and got castled from behind while winning
    // everywhere else. Measured: it lost 50% of games to a plain castle rush
    // with all 10 units alive and 0 defenders home.
    //
    // Scale the penalty by how close the nearest raider is, so holding a
    // defender back is worth it exactly when the threat is real.
    if (!oppInMyCastle && !myDefendingOwnCastle) {
      const home = this.castleZone(me);
      const homeRow = home.row + 2;
      const homeCol = home.col + 2;
      let nearest = Infinity;
      for (const ou of oppUnits) {
        const d = manhattan(ou.row, ou.col, homeRow, homeCol);
        if (d < nearest) nearest = d;
      }
      // Within raidThreatRadius cells the raid is live; further away it barely matters.
      if (nearest <= W.castle.raidThreatRadius)
        score -= (W.castle.raidThreatRadius + 1 - nearest) * W.castle.raidThreatPerCell;
    }

    // ── GOAL 3: Finish wounded enemies ──────────────────────────────────────
    // Extra value for enemies that are already damaged — incentivises focus-fire.
    oppUnits.forEach((ou) => {
      if (ou.hp < ou.maxHp) {
        score += (1 - ou.hp / ou.maxHp) * W.focus.woundedEnemyMax;
      }
    });

    // ── GOAL 4: Outnumbered? retreat toward own castle ───────────────────────
    // When I have fewer units I should play defensively, not charge in.
    if (myCount < oppCount) {
      const { row: homeRow, col: homeCol } = this.castleZone(me);
      const homeCenterRow = homeRow + 2;
      const homeCenterCol = homeCol + 2;
      myUnits.forEach((mu) => {
        const distHome = manhattan(mu.row, mu.col, homeCenterRow, homeCenterCol);
        score +=
          Math.max(0, W.retreat.outnumberedHomeRadius - distHome) *
          W.retreat.outnumberedHomePerCell *
          (oppCount - myCount);
      });
    }

    // ── Castle approach (existing, kept) ────────────────────────────────────
    if (this.config.castleApproachWeight > 0) {
      const { row: myGoalRow, col: myGoalCol } = this.castleZone(opp);
      const myGoalCenterRow = myGoalRow + 2;
      const myGoalCenterCol = myGoalCol + 2;
      const { row: oppGoalRow, col: oppGoalCol } = this.castleZone(me);
      const oppGoalCenterRow = oppGoalRow + 2;
      const oppGoalCenterCol = oppGoalCol + 2;
      let myAdvance = 0;
      let oppAdvance = 0;
      myUnits.forEach((u) => {
        myAdvance += 28 - manhattan(u.row, u.col, myGoalCenterRow, myGoalCenterCol);
      });
      oppUnits.forEach((u) => {
        oppAdvance += 28 - manhattan(u.row, u.col, oppGoalCenterRow, oppGoalCenterCol);
      });
      score += (myAdvance - oppAdvance) * W.castle.approachPerCell * this.config.castleApproachWeight;
    }

    // NOTE: the scenario/game-plan pull is NOT applied here. It used to call
    // pathDist per unit inside evaluateLightState, which runs thousands of times
    // per MCTS turn → unacceptable per-turn latency. The strategic march is now
    // driven entirely by applyStrategicOverlay() post-search (cheap, once/turn),
    // so this hot path stays the original fast tactical evaluation.

    // ── GOAL 5: Ranged units — keep distance, penalise melee exposure ────────
    // Archer/crossbow optimal range is 2; catapult optimal is 3-6.
    // Penalise them for being adjacent to enemies (they should kite, not brawl).
    myUnits.forEach((mu) => {
      if (mu.type === 'archer' || mu.type === 'crossbow') {
        let minEnemyDist = 99;
        oppUnits.forEach((ou) => {
          minEnemyDist = Math.min(minEnemyDist, manhattan(mu.row, mu.col, ou.row, ou.col));
        });
        if (minEnemyDist <= 1)
          score -= W.spacing.rangedAdjacentPenalty; // adjacent = bad, will get hit for free
        else if (minEnemyDist === 2)
          score += W.spacing.rangedOptimalBonus; // perfect kiting range
        else if (minEnemyDist <= 4) score += W.spacing.rangedNearBonus;
      } else if (mu.type === 'catapult') {
        let minEnemyDist = 99;
        oppUnits.forEach((ou) => {
          minEnemyDist = Math.min(minEnemyDist, manhattan(mu.row, mu.col, ou.row, ou.col));
        });
        if (minEnemyDist < 3)
          score -= W.spacing.catapultTooCloseWithinPenalty; // inside minimum range, can't fire
        else if (minEnemyDist <= 6) score += W.spacing.catapultOptimalBonus; // optimal range
      } else {
        // Melee units (knight, samurai, cavalry): reward being close to enemies.
        let minDist = 99;
        oppUnits.forEach((ou) => {
          minDist = Math.min(minDist, manhattan(mu.row, mu.col, ou.row, ou.col));
        });
        if (minDist <= 2) score += W.spacing.meleeCloseBonus;
        else if (minDist <= 4) score += W.spacing.meleeNearBonus;
      }
    });

    // ── Opponent threat / counter potential (existing, kept) ─────────────────
    if (this.config.opponentThreatWeight > 0 && oppUnits.length > 0 && myUnits.length > 0) {
      let threatPenalty = 0;
      let counterValue = 0;
      oppUnits.forEach((opp) => {
        let bestDmg = 0;
        let bestVictimValue = 0;
        let bestLethal = false;
        myUnits.forEach((mu) => {
          const dist = manhattan(opp.row, opp.col, mu.row, mu.col);
          const reach =
            opp.type === 'archer' || opp.type === 'crossbow' ? 2 : opp.type === 'catapult' ? 6 : 1;
          if (dist > reach) return;
          let dmg = opp.damage;
          if (state.damageBuff[opp.player] > 0) dmg += 2;
          dmg = Math.max(0, dmg - mu.armor);
          if (state.shieldTurns[mu.player] > 0) dmg = Math.max(0, dmg - 2);
          if (dmg > bestDmg) {
            bestDmg = dmg;
            bestVictimValue = this.simUnitValue(mu);
            bestLethal = dmg >= mu.hp;
          }
        });
        // Losing a unit outright is categorically worse than taking damage, and
        // scaling by damage alone did not express that: a 3 hp archer standing
        // next to cavalry that one-shots it scored the same as a unit merely
        // being chipped. That is exactly how the bot kept feeding archers into
        // trades it could not win. A hanging unit is charged its full value.
        threatPenalty +=
          bestDmg * W.threat.perDamagePoint +
          (bestDmg >= 1 ? bestVictimValue * W.threat.victimValueFraction : 0);
        if (bestLethal) threatPenalty += bestVictimValue;
      });
      myUnits.forEach((mu) => {
        let bestDmg = 0;
        let bestKillValue = 0;
        oppUnits.forEach((opp) => {
          const dist = manhattan(mu.row, mu.col, opp.row, opp.col);
          const reach =
            mu.type === 'archer' || mu.type === 'crossbow' ? 2 : mu.type === 'catapult' ? 6 : 1;
          if (dist > reach) return;
          let dmg = mu.damage;
          if (state.damageBuff[mu.player] > 0) dmg += 2;
          dmg = Math.max(0, dmg - opp.armor);
          if (state.shieldTurns[opp.player] > 0) dmg = Math.max(0, dmg - 2);
          if (dmg > bestDmg) {
            bestDmg = dmg;
            bestKillValue = dmg >= opp.hp ? this.simUnitValue(opp) : 0;
          }
        });
        // Symmetrically: a kill we can make is worth the whole enemy unit, not
        // just the damage number.
        counterValue += bestDmg * W.threat.perDamagePoint + bestKillValue;
      });
      score += (counterValue - threatPenalty) * this.config.opponentThreatWeight;
    }

    // ── Cohesion (existing, kept) ─────────────────────────────────────────────
    if (this.config.cohesionWeight > 0 && myUnits.length > 1) {
      let isolated = 0;
      myUnits.forEach((mu) => {
        let nearby = 0;
        myUnits.forEach((al) => {
          if (al.id === mu.id) return;
          if (manhattan(mu.row, mu.col, al.row, al.col) <= W.cohesion.radius) nearby += 1;
        });
        if (nearby === 0) isolated += 1;
      });
      score -= isolated * W.cohesion.isolatedPenalty * this.config.cohesionWeight;
    }

    // ── D: Hanging piece penalty ──────────────────────────────────────────────
    // For each of my units, sum expected damage from all enemies that could
    // realistically reach it next turn (current position + 1 move + attack
    // range). If the combined threat exceeds the unit's HP, it's "hanging".
    // Penalty stays below a kill reward (25k+) so the AI still trades UP
    // willingly — it just avoids leaving valuable units exposed for nothing.
    myUnits.forEach((mu) => {
      let totalThreat = 0;
      oppUnits.forEach((ou) => {
        const dist = manhattan(ou.row, ou.col, mu.row, mu.col);
        // Enemy reach = 1 step movement + attack range
        const atkRange =
          ou.type === 'archer' || ou.type === 'crossbow' ? 2 : ou.type === 'catapult' ? 6 : 1;
        const moveRange = ou.type === 'catapult' ? 1 : (ou.maxMoves ?? 2);
        if (dist > moveRange + atkRange) return;
        // Catapult minimum range check
        if (ou.type === 'catapult' && dist < 3) return;
        let dmg = ou.damage;
        if (state.damageBuff[ou.player] > 0) dmg += 2;
        dmg = Math.max(0, dmg - mu.armor);
        if (state.shieldTurns[mu.player] > 0) dmg = Math.max(0, dmg - 2);
        totalThreat += dmg;
      });
      if (totalThreat >= mu.hp) {
        // Unit is lethal-threatened. Penalty proportional to unit value, capped
        // below the value of the unit itself so the bot still trades up.
        const unitVal = this.simUnitValue(mu);
        score -= Math.min(
          W.threat.hangingMax,
          W.threat.hangingBase + unitVal * W.threat.hangingValueFraction,
        );
      } else if (totalThreat > mu.hp * W.threat.heavilyThreatenedRatio) {
        // Heavily threatened but not yet lethal — smaller warning penalty.
        score -= W.threat.heavilyThreatenedPenalty;
      }
    });

    // ── C: Low-HP retreat nudge ───────────────────────────────────────────────
    // Wounded units (below 35% HP) get a bonus for being farther from enemies.
    // This is a nudge, not an override — attack rewards still dominate if a
    // kill is available. Max bonus per unit is 3000 (much less than a kill).
    myUnits.forEach((mu) => {
      if (mu.hp >= mu.maxHp * W.retreat.lowHpThreshold) return;
      const hpFraction = mu.hp / mu.maxHp; // 0..lowHpThreshold
      let minEnemyDist = 99;
      oppUnits.forEach((ou) => {
        minEnemyDist = Math.min(minEnemyDist, manhattan(mu.row, mu.col, ou.row, ou.col));
      });
      // Reward distance: farther = safer for a wounded unit.
      const distBonus = Math.min(
        W.retreat.lowHpDistBonusMax,
        minEnemyDist * W.retreat.lowHpDistBonusPerCell * (1 - hpFraction),
      );
      score += distBonus;
    });

    score += this.evaluateEconomy(state, me);

    return score;
  }

  /**
   * Economy term — artifacts held, recipes completed, ruins control.
   *
   * This did not exist before. `generateActionsForLightState` has emitted
   * `draw` / `craft` / `spell` for a while, but nothing in the evaluation ever
   * looked at `state.inventory`, so from the search's point of view searching
   * ruins spent a unit's entire activation to change the position by exactly
   * zero. MCTS therefore essentially never chose it, and crafting looked like a
   * pure loss (it consumes artifacts, and the payoff arrives further away than
   * the rollout horizon). The whole economy layer was dead on `hard`, where
   * `trustSearch` keeps the search plan verbatim.
   *
   * Values are deliberately modest (a full recipe is worth well under a unit):
   * artifacts win nothing until they are spent, and over-pricing them makes the
   * bot farm ruins while the enemy walks into its castle.
   */
  private evaluateEconomy(state: LightState, me: Player): number {
    if (this.config.economyWeight <= 0) return 0;
    const inv = state.inventory;
    let score = 0;

    for (const art of Object.keys(inv) as ArtifactName[]) {
      const count = inv[art] ?? 0;
      if (count <= 0) continue;
      score += count * (W.economy.artifactByName[art] ?? W.economy.artifactBase);
    }

    // A complete recipe is worth more than the sum of its reagents: that is the
    // point where the artifacts convert into permanent stats or a spell.
    const affordable = (recipe: Partial<Record<ArtifactName, number>>): boolean =>
      (Object.keys(recipe) as ArtifactName[]).every((a) => (inv[a] ?? 0) >= (recipe[a] ?? 0));
    for (const spell of SPELLS) if (affordable(spell.recipe)) score += W.economy.completeRecipeBonus;
    for (const w of WEAPONS) if (affordable(w.recipe)) score += W.economy.completeRecipeBonus;
    for (const a of ARMORS) if (affordable(a.recipe)) score += W.economy.completeRecipeBonus;

    // Standing on / heading toward the ruins. Small, so it only decides moves
    // that are otherwise neutral — never outweighs a kill or a castle race.
    const myUnits = state.units.filter((u) => u.player === me && u.hp > 0);
    for (const u of myUnits) {
      if (this.inRuins(u.row, u.col)) {
        score += W.economy.ruinsControlBonus;
        continue;
      }
    }
    const ruins = getAllRuins();
    if (ruins.length > 0 && myUnits.length > 0) {
      // Only the single closest unit is pulled, so the bot sends a scout rather
      // than marching the whole army onto the loot tile.
      let nearest = Infinity;
      for (const u of myUnits) {
        for (const r of ruins) {
          const d = manhattan(
            u.row,
            u.col,
            r.top + Math.floor(r.height / 2),
            r.left + Math.floor(r.width / 2),
          );
          if (d < nearest) nearest = d;
        }
      }
      if (nearest <= W.economy.ruinsApproachRadius) {
        score += (W.economy.ruinsApproachRadius - nearest) * W.economy.ruinsApproachPerCell;
      }
    }

    // Active spell effects, which otherwise show up nowhere in the evaluation.
    score += (state.shieldTurns[me] ?? 0) * W.buffs.shieldPerTurn;
    score += (state.damageBuff[me] ?? 0) * W.buffs.damageBuffPerTurn;
    const opp: Player = me === 1 ? 2 : 1;
    score -= (state.shieldTurns[opp] ?? 0) * W.buffs.shieldPerTurn;
    score -= (state.damageBuff[opp] ?? 0) * W.buffs.damageBuffPerTurn;

    return score * this.config.economyWeight;
  }

  /**
   * The light-state moves/attacks with the facing rule on top (facing.ts):
   * stepping or striking into the unit's own back half costs +1 — the same
   * surcharge generateLegalMoves/generateAttackActions add, applied once here
   * so the hand-mirrored per-type generator below stays as it was.
   */
  private generateActionsForLightState(state: LightState, unit: LightUnit): AIAction[] {
    const out: AIAction[] = [];
    for (const a of this.generateBaseActionsForLightState(state, unit)) {
      const cell =
        a.type === 'move'
          ? { row: a.row, col: a.col }
          : a.type === 'attack'
            ? (a.pierce?.[0] ?? { row: a.targetRow, col: a.targetCol })
            : null;
      if (!cell || cell.row === undefined || cell.col === undefined) {
        out.push(a);
        continue;
      }
      const turn = turnCost(unit, cell.row, cell.col);
      if (turn === 0) out.push(a);
      else if ((a.cost ?? 1) + turn <= unit.movesLeft) out.push({ ...a, cost: (a.cost ?? 1) + turn });
    }
    return out;
  }

  private generateBaseActionsForLightState(state: LightState, unit: LightUnit): AIAction[] {
    const actions: AIAction[] = [];
    const ortho: Array<[number, number]> = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    const all8: Array<[number, number]> = [...ortho, [-1, -1], [-1, 1], [1, -1], [1, 1]];
    // "Occupied" must mean everything Board.isFree() rejects, not just units:
    // rivers and mountains are impassable too. Leaving terrain out made the
    // search plan moves onto water and rock that the game silently refused
    // (measured in a live game: 10 of 80 moves rejected, 12.5%), wasting the
    // unit's activation. Bridges sit on river cells and ARE passable.
    const occupied = (r: number, c: number): boolean => {
      if (state.units.some((u) => u.row === r && u.col === c && u.hp > 0)) return true;
      return AIPlayer.isBlockedTerrain(r, c);
    };
    const enemyAt = (r: number, c: number): LightUnit | undefined =>
      state.units.find((u) => u.row === r && u.col === c && u.player !== unit.player && u.hp > 0);
    const { row, col, movesLeft } = unit;

    if (unit.type === 'crossbow') {
      // Crossbow (mirrors game-rules moves.ts): steps 1 cell, and its only
      // attack is the 2-cell piercing bolt along one of 8 lines, flat cost 2,
      // hitting EVERY unit on the line. It used to be simulated as an archer
      // (any enemy in a 5×5 square), so most planned shots did not exist in
      // the real game and were rejected. Lines with an ally on them are left
      // out — the bolt would hit our own unit.
      if (movesLeft >= 1) {
        ortho.forEach((d) => {
          const nr = row + d[0];
          const nc = col + d[1];
          if (insideBoard(nr, nc) && !occupied(nr, nc)) {
            actions.push({ type: 'move', row: nr, col: nc, cost: 1, score: 0 });
          }
        });
      }
      if (movesLeft >= CROSSBOW_PIERCE_COST) {
        const dirs8 = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]] as const;
        for (const [dr, dc] of dirs8) {
          const line: Array<{ row: number; col: number }> = [];
          for (let k = 1; k <= CROSSBOW_PIERCE_RANGE; k += 1) {
            const r = row + dr * k;
            const c = col + dc * k;
            if (!insideBoard(r, c)) break;
            line.push({ row: r, col: c });
          }
          if (line.length === 0) continue;
          const onLine = line
            .map((cell) => state.units.find((u) => u.row === cell.row && u.col === cell.col && u.hp > 0))
            .filter((u): u is LightUnit => !!u);
          if (onLine.some((u) => u.player === unit.player)) continue; // friendly fire
          const firstEnemy = onLine[0];
          if (!firstEnemy) continue;
          actions.push({
            type: 'attack',
            row,
            col,
            targetRow: firstEnemy.row,
            targetCol: firstEnemy.col,
            landingRow: row,
            landingCol: col,
            cost: CROSSBOW_PIERCE_COST,
            score: 0,
            pierce: line,
          });
        }
      }
    } else if (unit.type === 'archer') {
      // Ranged: stays in place, attacks within Chebyshev-2 square.
      // Cost = Chebyshev distance (mirrors game-rules moves.ts).
      // Multi-cell walk is an archer-only rule (game-rules moves.ts breaks the
      // per-direction loop after one step for every other type), and it is
      // bounded by the unit's own move budget — not a hard-coded 2, which made
      // the search blind to the archer's third step.
      const maxStep = unit.type === 'archer' ? (unit.maxMoves || 3) : 1;
      if (movesLeft >= 1) {
        ortho.forEach((d) => {
          for (let s = 1; s <= Math.min(maxStep, movesLeft); s += 1) {
            const nr = row + d[0] * s;
            const nc = col + d[1] * s;
            if (!insideBoard(nr, nc) || occupied(nr, nc)) break;
            actions.push({ type: 'move', row: nr, col: nc, cost: s, score: 0 });
          }
        });
        // ~1.5× range from a tower, same rule as moves.ts archerRadiusFor.
        const radius = archerRadiusFor(AIPlayer.isTowerCell(row, col));
        state.units
          .filter((u) => u.player !== unit.player && u.hp > 0)
          .forEach((enemy) => {
            const cost = Math.max(Math.abs(enemy.row - row), Math.abs(enemy.col - col));
            if (cost <= radius && movesLeft >= cost) {
              actions.push({
                type: 'attack',
                row,
                col,
                targetRow: enemy.row,
                targetCol: enemy.col,
                landingRow: row,
                landingCol: col,
                cost,
                score: 0,
              });
            }
          });
      }
    } else if (unit.type === 'catapult') {
      // Bombardment: attacks any enemy at manhattan 3-6, stays in place, 1 move.
      if (movesLeft >= 1) {
        ortho.forEach((d) => {
          const nr = row + d[0];
          const nc = col + d[1];
          if (insideBoard(nr, nc) && !occupied(nr, nc)) {
            actions.push({ type: 'move', row: nr, col: nc, cost: 1, score: 0 });
          }
        });
        state.units
          .filter((u) => u.player !== unit.player && u.hp > 0)
          .forEach((enemy) => {
            const dist = manhattan(row, col, enemy.row, enemy.col);
            if (dist >= CATAPULT_MIN_RANGE && dist <= catapultMaxRangeFor(AIPlayer.isTowerCell(row, col))) {
              actions.push({
                type: 'attack',
                row,
                col,
                targetRow: enemy.row,
                targetCol: enemy.col,
                landingRow: row,
                landingCol: col,
                cost: 1,
                score: 0,
              });
            }
          });
      }
    } else if (unit.type === 'cavalry') {
      // Jump attacker: lands beyond target (or to side), costs 2 moves.
      if (movesLeft >= 1) {
        ortho.forEach((d) => {
          const nr = row + d[0];
          const nc = col + d[1];
          if (insideBoard(nr, nc) && !occupied(nr, nc)) {
            actions.push({ type: 'move', row: nr, col: nc, cost: 1, score: 0 });
          }
        });
      }
      // River leap (moves.ts): clear exactly one cell of water for 2 moves.
      if (movesLeft >= CAVALRY_RIVER_JUMP_COST) {
        ortho.forEach((d) => {
          if (!AIPlayer.isRiverCell(row + d[0], col + d[1])) return;
          const lr = row + d[0] * 2;
          const lc = col + d[1] * 2;
          if (!insideBoard(lr, lc) || AIPlayer.isRiverCell(lr, lc) || occupied(lr, lc)) return;
          actions.push({ type: 'move', row: lr, col: lc, cost: CAVALRY_RIVER_JUMP_COST, score: 0 });
        });
      }
      if (movesLeft >= 2) {
        ortho.forEach((d) => {
          const er = row + d[0];
          const ec = col + d[1];
          if (!enemyAt(er, ec)) return;
          const lr = er + d[0];
          const lc = ec + d[1];
          if (insideBoard(lr, lc) && !occupied(lr, lc)) {
            actions.push({
              type: 'attack',
              row: lr,
              col: lc,
              targetRow: er,
              targetCol: ec,
              landingRow: lr,
              landingCol: lc,
              cost: 2,
              score: 0,
            });
          }
          // Г-attack (l-attack): land to either SIDE of the target instead of
          // straight past it. generateAttackActions only offers the two cells
          // PERPENDICULAR to the approach direction — this used to try all 4
          // orthogonal offsets (including straight back past the attacker's own
          // square, and the straight-through direction that duplicates the jump
          // above), so half of these candidates were moves the game does not
          // have in its own attack list and silently rejected.
          const perps: Array<[number, number]> = [
            [d[1], d[0]],
            [-d[1], -d[0]],
          ];
          perps.forEach((p) => {
            const lr2 = er + p[0];
            const lc2 = ec + p[1];
            if (insideBoard(lr2, lc2) && !occupied(lr2, lc2)) {
              actions.push({
                type: 'attack',
                row: lr2,
                col: lc2,
                targetRow: er,
                targetCol: ec,
                landingRow: lr2,
                landingCol: lc2,
                cost: 2,
                score: 0,
              });
            }
          });
        });
      }
    } else if (unit.type === 'samurai') {
      // Attacks in 8 directions, but MOVES like everyone else: one orthogonal
      // step per action (see generateLegalMoves in @kc/game-rules — every
      // non-archer `break`s after the first step, and there are no diagonal
      // moves at all). This used to emit 8 directions × 2 steps: 12 of the 16
      // moves it produced were rejected outright by the game.
      const dirs = all8;
      ortho.forEach((d) => {
        const nr = row + d[0];
        const nc = col + d[1];
        if (insideBoard(nr, nc) && !occupied(nr, nc)) {
          actions.push({ type: 'move', row: nr, col: nc, cost: 1, score: 0 });
        }
      });
      if (movesLeft >= 1) {
        dirs.forEach((d) => {
          const er = row + d[0];
          const ec = col + d[1];
          if (enemyAt(er, ec)) {
            actions.push({
              type: 'attack',
              row,
              col,
              targetRow: er,
              targetCol: ec,
              landingRow: row,
              landingCol: col,
              cost: 1,
              score: 0,
            });
          }
        });
      }
    } else if (unit.type === 'mage') {
      // The mage has no plain attack (its abilities are separate actions the
      // search doesn't model) — it used to fall into the knight branch and
      // plan 0-damage melee swings the game has no such action for, burning
      // an activation on a rejected step. Steps only.
      if (movesLeft >= 1) {
        ortho.forEach((d) => {
          const nr = row + d[0];
          const nc = col + d[1];
          if (insideBoard(nr, nc) && !occupied(nr, nc)) {
            actions.push({ type: 'move', row: nr, col: nc, cost: 1, score: 0 });
          }
        });
      }
    } else {
      // knight: orthogonal melee, stays in place after attack.
      // ONE step per action — a knight with 2 movesLeft takes two separate
      // 1-cell actions, it does not slide 2 cells in one. Emitting the 2-cell
      // version made half of every knight's candidate moves illegal, and the
      // opening is 7 knights out of 10 units.
      ortho.forEach((d) => {
        const nr = row + d[0];
        const nc = col + d[1];
        if (insideBoard(nr, nc) && !occupied(nr, nc)) {
          actions.push({ type: 'move', row: nr, col: nc, cost: 1, score: 0 });
        }
      });
      if (movesLeft >= 1) {
        ortho.forEach((d) => {
          const er = row + d[0];
          const ec = col + d[1];
          if (enemyAt(er, ec)) {
            actions.push({
              type: 'attack',
              row,
              col,
              targetRow: er,
              targetCol: ec,
              landingRow: row,
              landingCol: col,
              cost: 1,
              score: 0,
            });
          }
        });
      }
    }
    // Searching ruins for loot. The MCTS generator used to emit only
    // move/attack/skip, so the search could never choose to farm artifacts —
    // and on `hard` (trustSearch) the strategic overlay keeps the search plan
    // as-is, which meant the economy was effectively switched off at the
    // highest difficulty. Costs the unit's whole remaining turn.
    if (movesLeft >= 1 && this.config.economyWeight > 0 && this.inRuins(row, col)) {
      actions.push({ type: 'draw', cost: movesLeft, score: 0 });
    }

    // Spells (from a mage tower) and crafting. Both spend artifacts, which is
    // why the light state now carries an inventory — the search can only pick
    // these once it can tell whether they are affordable.
    if (movesLeft >= 1 && unit.player === this.player) {
      const inv = state.inventory;
      const affordable = (recipe: Partial<Record<ArtifactName, number>>): boolean =>
        (Object.keys(recipe) as ArtifactName[]).every(
          (art) => (inv[art] ?? 0) >= (recipe[art] ?? 0),
        );

      if (this.game.board.isTower(row, col)) {
        SPELLS.forEach((spell, index) => {
          if (affordable(spell.recipe)) {
            actions.push({ type: 'spell', index, cost: 1, score: 0 });
          }
        });
      }

      if (this.config.economyWeight > 0 && !this.game.pendingWeaponEquip) {
        WEAPONS.forEach((w, index) => {
          if (!affordable(w.recipe)) return;
          // Only craft gear something can actually equip.
          const hasRecipient = state.units.some(
            (u) =>
              u.player === unit.player &&
              u.hp > 0 &&
              (w.archerOnly
                ? u.type === 'archer' || u.type === 'crossbow'
                : !(w.forbidTypes ?? []).includes(u.type as never)),
          );
          if (hasRecipient) actions.push({ type: 'craft', index, cost: 1, score: 0 });
        });
      }
    }

    actions.push({ type: 'skip', cost: 0, score: 0 });
    return actions;
  }

  private evaluateSacrifice(unit: Unit, attackAction: AttackAction): number {
    if (!this.config.sacrificeEval) return 0;
    const target = this.game.board.unitAt(attackAction.targetRow, attackAction.targetCol);
    if (!target) return 0;
    const dmg = this.game.computeDamage(unit, target);
    const willKill = dmg >= target.hp;
    const willDie = !this.isSafePosition(attackAction.landingRow, attackAction.landingCol, unit);
    if (willKill && willDie) {
      const trade = this.calculateUnitValue(target) - this.calculateUnitValue(unit);
      return trade > 2000 ? trade : trade > 0 ? trade * 0.5 : trade;
    }
    return 0;
  }

  private evaluatePositionalAdvantage(row: number, col: number, unit: Unit): number {
    if (this.config.territoryWeight <= 0.3) return 0;
    const enemies = this.game.ownUnits(otherPlayer(this.player));
    let value = 0;
    enemies.forEach((enemy) => {
      const dist = manhattan(row, col, enemy.row, enemy.col);
      if (unit.type === 'archer') {
        if (dist <= 3) value += 800;
        if (dist === 1) value += 400;
      } else {
        if (dist === 2) value += 1200;
        if (dist === 1) value += 600;
        if (dist === 3) value += 400;
      }
    });
    if (col >= 4 && col <= 5 && row >= 7 && row <= 12) value += 500;
    return value;
  }

  private evaluateBestFutureSpell(
    currentInv: Record<ArtifactName, number>,
    excludeIndex: number,
  ): number {
    let bestValue = 0;
    const allies = this.game.ownUnits(this.player);
    SPELLS.forEach((spell, index) => {
      if (index === excludeIndex) return;
      let missing = 0;
      (Object.keys(spell.recipe) as ArtifactName[]).forEach((art) => {
        missing += Math.max(0, (spell.recipe[art] ?? 0) - (currentInv[art] ?? 0));
      });
      if (missing > 1) return;
      let value = 0;
      if (index === 2) value = this.evaluateThreats().filter((t) => t.lethal).length * 6000;
      else if (index === 0)
        value = allies.reduce((s, a) => s + Math.max(0, a.maxHp - a.hp), 0) * 2000;
      else if (index === 1) value = allies.filter((a) => a.armor === 0).length * 3000;
      bestValue = Math.max(bestValue, value);
    });
    return bestValue;
  }

  // ===========================================================================
  // Phase 2 AI overhaul — minimax with α-β, iterative deepening, and a
  // transposition table over LightState. All methods below are gated on
  // config.useMinimax && config.minimaxDepth >= 1. Only `hard` enables them.
  // ===========================================================================

  private searchNodes = 0;
  private searchDeadlineMs = 0;
  private searchTT = new Map<
    string,
    { depth: number; score: number; flag: 'exact' | 'lower' | 'upper' }
  >();

  private searchBestPlan(): PlanEntry[] {
    const root = this.createLightState();
    const me = this.player;
    const targetDepth = Math.max(1, Math.floor(this.scaleSearch(this.config.minimaxDepth)));
    const budgetMs = this.scaleBudget(
      this.config.searchTimeBudgetMs > 0 ? this.config.searchTimeBudgetMs : 250,
    );
    this.searchDeadlineMs =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) + budgetMs;
    this.searchNodes = 0;
    this.searchTT.clear();
    let bestPlan: PlanEntry[] = [];
    let bestScore = -Infinity;
    // Iterative deepening: drive the root level directly so we can collect
    // candidate plans, apply scoreNoise / mistakeChance at selection time,
    // and keep the α-β subtree itself deterministic.
    for (let d = 1; d <= targetDepth; d += 1) {
      const candidates = this.generateTopKTurnPlans(root, me);
      if (candidates.length === 0) break;
      const scored: { plan: PlanEntry[]; score: number }[] = [];
      let alpha = -Infinity;
      const beta = Infinity;
      for (const { plan, endState } of candidates) {
        if (this.outOfBudget()) break;
        const after = this.applyEndOfTurn(endState, me);
        const sub = this.minimaxSearch(after, otherPlayer(me), d - 1, alpha, beta, me);
        scored.push({ plan, score: sub.score });
        if (sub.score > alpha) alpha = sub.score;
      }
      if (scored.length === 0) break;
      // scoreNoise at root: handicap for easy mode. Doesn't poison the
      // search, just randomizes which of the top plans we pick.
      if (this.config.scoreNoise > 0) {
        scored.forEach((s) => {
          s.score += (Math.random() - 0.5) * 2 * this.config.scoreNoise;
        });
      }
      scored.sort((a, b) => b.score - a.score);
      // mistakeChance: occasionally pick the #2/#3 plan instead of the best.
      let picked = scored[0]!;
      if (
        this.config.mistakeChance > 0 &&
        scored.length > 1 &&
        Math.random() < this.config.mistakeChance
      ) {
        const idx = Math.min(scored.length - 1, 1 + Math.floor(Math.random() * 2));
        picked = scored[idx] ?? picked;
      }
      bestPlan = picked.plan;
      bestScore = picked.score;
      if (bestScore > 50000 || bestScore < -50000) break;
    }
    return bestPlan;
  }

  private outOfBudget(): boolean {
    const nodeBudget = this.scaleBudget(this.config.searchNodeBudget);
    if (this.searchNodes >= nodeBudget && nodeBudget > 0) return true;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return now >= this.searchDeadlineMs;
  }

  /**
   * Fixed-perspective minimax with α-β pruning. `ownPerspective` is the
   * player from whose viewpoint scores are returned; `player` is whose turn
   * it is at this node.
   */
  private minimaxSearch(
    state: LightState,
    player: Player,
    depth: number,
    alpha: number,
    beta: number,
    ownPerspective: Player,
  ): { score: number; plan: PlanEntry[] } {
    this.searchNodes += 1;

    // Terminal: someone wiped out.
    const myAlive = state.units.filter((u) => u.player === ownPerspective && u.hp > 0).length;
    const oppAlive = state.units.filter((u) => u.player !== ownPerspective && u.hp > 0).length;
    if (myAlive === 0) return { score: -100000 - depth * 1000, plan: [] };
    if (oppAlive === 0) return { score: 100000 + depth * 1000, plan: [] };

    if (depth <= 0 || this.outOfBudget()) {
      return { score: this.evaluateLightState(state, ownPerspective), plan: [] };
    }

    // TT lookup. We only key on (state, player, depth); ownPerspective is
    // constant within a single searchBestPlan() call.
    const ttKey = this.lightStateHash(state, player);
    const hit = this.searchTT.get(ttKey);
    if (hit && hit.depth >= depth) {
      if (hit.flag === 'exact') return { score: hit.score, plan: [] };
      if (hit.flag === 'lower' && hit.score >= beta) return { score: hit.score, plan: [] };
      if (hit.flag === 'upper' && hit.score <= alpha) return { score: hit.score, plan: [] };
    }

    const plans = this.generateTopKTurnPlans(state, player);
    if (plans.length === 0) {
      // No legal plan for this side — just end the turn.
      const after = this.applyEndOfTurn(state, player);
      const sub = this.minimaxSearch(
        after,
        otherPlayer(player),
        depth - 1,
        alpha,
        beta,
        ownPerspective,
      );
      return { score: sub.score, plan: [] };
    }

    let bestPlan: PlanEntry[] = plans[0]!.plan;
    const isMaxNode = player === ownPerspective;

    if (isMaxNode) {
      let best = -Infinity;
      let a = alpha;
      for (const { plan, endState } of plans) {
        const after = this.applyEndOfTurn(endState, player);
        const sub = this.minimaxSearch(
          after,
          otherPlayer(player),
          depth - 1,
          a,
          beta,
          ownPerspective,
        );
        if (sub.score > best) {
          best = sub.score;
          bestPlan = plan;
        }
        if (best > a) a = best;
        if (a >= beta) break;
        if (this.outOfBudget()) break;
      }
      this.recordTT(ttKey, depth, best, alpha, beta);
      return { score: best, plan: bestPlan };
    } else {
      let best = Infinity;
      let b = beta;
      for (const { plan, endState } of plans) {
        const after = this.applyEndOfTurn(endState, player);
        const sub = this.minimaxSearch(
          after,
          otherPlayer(player),
          depth - 1,
          alpha,
          b,
          ownPerspective,
        );
        if (sub.score < best) {
          best = sub.score;
          bestPlan = plan;
        }
        if (best < b) b = best;
        if (alpha >= b) break;
        if (this.outOfBudget()) break;
      }
      this.recordTT(ttKey, depth, best, alpha, beta);
      return { score: best, plan: bestPlan };
    }
  }

  private recordTT(key: string, depth: number, score: number, alpha: number, beta: number): void {
    let flag: 'exact' | 'lower' | 'upper' = 'exact';
    if (score <= alpha) flag = 'upper';
    else if (score >= beta) flag = 'lower';
    this.searchTT.set(key, { depth, score, flag });
    // Cheap eviction policy: cap TT at 20k entries.
    if (this.searchTT.size > 20000) {
      const firstKey = this.searchTT.keys().next().value;
      if (firstKey !== undefined) this.searchTT.delete(firstKey);
    }
  }

  /**
   * Generates up to `searchBreadth` candidate full-turn plans for `player`
   * by branching on the top-K starter actions then greedily completing.
   */
  private generateTopKTurnPlans(
    state: LightState,
    player: Player,
    breadthOverride?: number,
  ): { plan: PlanEntry[]; endState: LightState }[] {
    const K = Math.max(2, breadthOverride ?? this.scaleSearch(this.config.searchBreadth));
    const candidates = state.units.filter(
      (u) =>
        u.player === player &&
        u.hp > 0 &&
        !u.done &&
        u.movesLeft > 0 &&
        // Only units that already activated, or a fresh one while slots remain.
        (u.activated || state.activationsLeft > 0),
    );
    if (candidates.length === 0) return [];

    // Score every (unit, action) pair as a potential starter.
    interface Starter {
      unitId: number;
      action: AIAction;
      score: number;
    }
    const starters: Starter[] = [];
    candidates.forEach((u) => {
      const raw = this.generateActionsForLightState(state, u);
      const scored = this.scoreLightActions(state, u, raw, player);
      // Take top-3 actions per unit to diversify.
      scored.slice(0, 3).forEach((a) => {
        if (a.type !== 'skip') starters.push({ unitId: u.id, action: a, score: a.score });
      });
    });
    starters.sort((a, b) => b.score - a.score);

    const plans: { plan: PlanEntry[]; endState: LightState }[] = [];
    // Dedup on the SET of actions, not the sequence: completing greedily from
    // different starters mostly produces reorderings of the same turn, and
    // counting those as distinct candidates wasted the entire search budget.
    const seenSignatures = new Set<string>();
    const legacy = this.config.legacyPlanGen === true;
    const addPlan = (completed: { plan: PlanEntry[]; endState: LightState }): void => {
      if (completed.plan.length === 0) return;
      const sig = legacy
        ? this.planSignature(completed.plan)
        : this.planSetSignature(completed.plan);
      if (seenSignatures.has(sig)) return;
      seenSignatures.add(sig);
      plans.push(completed);
    };

    // Always include a fully-greedy plan as fallback.
    addPlan(this.completeTurnGreedy(state, player, null));
    for (let i = 0; i < starters.length && plans.length < K; i += 1) {
      const s = starters[i]!;
      addPlan(
        this.completeTurnGreedy(state, player, { unitId: s.unitId, action: s.action }),
      );
    }
    // Still short of the requested breadth because the greedy tail keeps
    // collapsing into the same turn? Re-complete the strongest starters with a
    // different SECOND decision. This is the only way the tree ever sees a turn
    // where two units cooperate rather than each taking its own local best.
    for (let rank = 1; rank <= 2 && !legacy && plans.length < K; rank += 1) {
      for (let i = 0; i < starters.length && plans.length < K; i += 1) {
        const s = starters[i]!;
        addPlan(
          this.completeTurnGreedy(state, player, { unitId: s.unitId, action: s.action }, rank),
        );
      }
    }
    return plans;
  }

  /**
   * Plays one side's turn greedily starting from `state`, optionally seeded
   * with a forced first action. Returns the executed plan and the
   * post-turn light state (still owned by `player` — caller applies the
   * end-of-turn transition).
   */
  /**
   * Completes a turn from `state`.
   *
   * `rank` picks WHICH action each unit takes: 0 = its best (pure greedy), 1 =
   * its second best, and so on, falling back to the best when a unit has fewer
   * options. Candidate plans used to differ only in their first action and then
   * share one identical greedy tail, so the tree could never represent a turn
   * where units COORDINATE (knight steps up to block, then the archer shoots
   * the blocked unit). Varying the completion is what lets the search find
   * those; without it, extra thinking time buys nothing but permutations.
   */
  private completeTurnGreedy(
    state: LightState,
    player: Player,
    firstAction: PlanEntry | null,
    rank = 0,
    noisy = false,
  ): { plan: PlanEntry[]; endState: LightState } {
    let cur = this.cloneLightState(state);
    const plan: PlanEntry[] = [];
    if (firstAction) {
      // Skip if the unit is gone or done at this state.
      const unit = cur.units.find((u) => u.id === firstAction.unitId && u.hp > 0 && !u.done);
      if (unit && (unit.movesLeft ?? 0) > 0) {
        cur = this.applyActionToState(cur, firstAction.unitId, firstAction.action);
        plan.push(firstAction);
      }
    }
    for (let iter = 0; iter < 24; iter += 1) {
      // Respect the activation cap: once the budget is spent, only units that
      // already activated this turn may keep acting. Planning past this point
      // produces entries the game will refuse to execute.
      const available = cur.units.filter(
        (u) =>
          u.player === player &&
          u.hp > 0 &&
          !u.done &&
          u.movesLeft > 0 &&
          (u.activated || cur.activationsLeft > 0),
      );
      if (available.length === 0) break;
      let bestEntry: { unitId: number; action: AIAction } | null = null;
      // Take the BEST action, even when every option scores negative. This used
      // to require a positive score, which silently assumed danger was never
      // priced into the score. Once threat penalties can push a whole position
      // below zero — exactly what happens when the armies meet — that threshold
      // returned an EMPTY plan and the bot stood still for the rest of the game
      // rather than choosing the least-bad move.
      let bestScore = -Infinity;
      for (const unit of available) {
        const raw = this.generateActionsForLightState(cur, unit);
        const scored = this.scoreLightActions(cur, unit, raw, player);
        // Only the FIRST decision of the turn is varied by rank; the rest stay
        // greedy. Varying every step would make the completion mostly noise
        // instead of a plausible continuation.
        let pick = iter === 0 && rank > 0 ? (scored[rank] ?? scored[0]) : scored[0];
        // Rollout policy noise. A fully greedy playout models the opponent as a
        // machine that always takes the locally best action — which is exactly
        // what a human is not. Humans set up trades, bait, and give up material
        // for position, and none of those lines survive a simulation that
        // answers every move with the obvious reply. Occasionally taking the
        // 2nd/3rd-best action widens the distribution of replies the search
        // prices in, so the value of a line reflects a range of answers rather
        // than one optimistic guess.
        if (noisy && scored.length > 1 && Math.random() < W.rollout.opponentNoiseChance) {
          const k = Math.min(W.rollout.opponentNoiseTopK, scored.length);
          pick = scored[Math.floor(Math.random() * k)] ?? pick;
        }
        const top = pick;
        if (!top || top.type === 'skip') continue;
        if ((top.score ?? 0) > bestScore) {
          bestScore = top.score ?? 0;
          bestEntry = { unitId: unit.id, action: top };
        }
      }
      if (!bestEntry) break;
      // Stop once nothing worthwhile is left. Without this the loop keeps
      // spending move points on whatever scores least-badly, which is how a unit
      // ended up shuffling 7,9 → 7,8 → 8,8 inside a single turn: three actions
      // that achieve nothing, burn the activation and leave it out of position.
      // Negative scores are still allowed for the FIRST action of a unit's turn
      // (retreating out of a lethal envelope is negative but necessary); this
      // only cuts the aimless tail.
      // Only cut the tail when the unit is genuinely out of useful ideas AND
      // the position is not about to be decided. `bestScore <= 0` alone was too
      // eager: the winning walk into an undefended enemy castle scores in the
      // hundreds (the mover-level scorer has no castle-capture term — that lives
      // in evaluateLightState), so stopping there threw the win away.
      if (
        plan.length > 0 &&
        bestScore <= -1000 &&
        this.config.legacyPlanGen !== true
      ) {
        break;
      }
      cur = this.applyActionToState(cur, bestEntry.unitId, bestEntry.action);
      plan.push(bestEntry);
    }
    return { plan, endState: cur };
  }

  /**
   * Scores a unit's raw light-state actions from `perspective`'s viewpoint.
   * Returns the full list sorted best-first.
   */
  private scoreLightActions(
    state: LightState,
    simUnit: LightUnit,
    rawActions: AIAction[],
    perspective: Player,
  ): AIAction[] {
    const scored = this.scoreLightActionsUnsorted(state, simUnit, rawActions, perspective);
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return scored;
  }

  /** The scoring body, without the final sort. */
  private scoreLightActionsUnsorted(
    state: LightState,
    simUnit: LightUnit,
    rawActions: AIAction[],
    perspective: Player,
  ): AIAction[] {
    const scored: AIAction[] = [];
    const isOwnPerspective = perspective === this.player;
    const enemies = state.units.filter((u) => u.player !== perspective && u.hp > 0);
    // Danger at the unit's CURRENT square: identical for every candidate action,
    // so compute it once rather than per action in this hot loop.
    const threatNow = this.simThreatAt(state, simUnit.row, simUnit.col, simUnit, null);
    const diesHere = threatNow >= simUnit.hp;
    for (const raw of rawActions) {
      if (raw.type === 'skip') continue;
      if (raw.type === 'draw') {
        // Ruins loot is random, so this is an expected-value bid rather than a
        // simulated reward: what the artifacts are worth toward spell/weapon
        // recipes, minus the tempo of giving up the unit's turn. Only worth it
        // when the unit is not needed for something sharper — the search
        // compares this against the unit's own attacks and moves.
        let score = 1800 + this.evaluateArtifactNeed();
        score = Math.round(score * this.config.economyWeight);
        // Farming under threat loses the unit and the loot both.
        if (diesHere) score -= 6000;
        // Economy is a luxury: never farm while the home castle is open and a
        // raider is closing on it. Observed directly — with an enemy cavalry
        // four cells from an empty castle, one knight correctly ran home while
        // the other spent its turn searching ruins.
        if (this.homeIsThreatened(state, perspective)) score -= 60_000;
        scored.push({ type: 'draw', cost: raw.cost, score });
        continue;
      }
      if (raw.type === 'spell' && raw.index !== undefined) {
        // Valued by what the spell actually does to THIS position, so the search
        // casts when it pays rather than on sight.
        const allies = state.units.filter((u) => u.player === simUnit.player && u.hp > 0);
        let score = 0;
        if (raw.index === 0) {
          // +2 HP to all: worth the HP actually restored (capped by maxHp).
          const healed = allies.reduce((n, a) => n + Math.min(2, a.maxHp - a.hp), 0);
          score = healed * 1800;
        } else if (raw.index === 1) {
          // +2 armour, capped at the unit's starting armour.
          const restored = allies.reduce((n, a) => n + Math.min(2, a.maxArmor - a.armor), 0);
          score = restored * 1500;
        } else if (raw.index === 2) {
          // +2 damage for 2 turns — strongest when many units can swing.
          score = state.damageBuff[simUnit.player] > 0 ? 0 : allies.length * 2200;
        }
        if (score > 0) scored.push({ type: 'spell', index: raw.index, cost: raw.cost, score });
        continue;
      }
      if (raw.type === 'craft' && raw.index !== undefined) {
        // Crafting is a durable upgrade; weight it by the economy dial so the
        // weaker presets don't gear up as hard.
        const score = Math.round(7000 * this.config.economyWeight);
        scored.push({ type: 'craft', index: raw.index, cost: raw.cost, score });
        continue;
      }
      if (raw.type === 'attack' && raw.targetRow !== undefined && raw.targetCol !== undefined) {
        const target = state.units.find(
          (u) =>
            u.row === raw.targetRow &&
            u.col === raw.targetCol &&
            u.player !== perspective &&
            u.hp > 0,
        );
        if (!target) continue;
        let dmg = simUnit.damage;
        if (state.damageBuff[simUnit.player] > 0) dmg += 2;
        dmg = Math.max(0, dmg - target.armor);
        if (state.shieldTurns[target.player] > 0) dmg = Math.max(0, dmg - 2);
        const lr = raw.landingRow !== undefined ? raw.landingRow : simUnit.row;
        const lc = raw.landingCol !== undefined ? raw.landingCol : simUnit.col;
        let score = 0;
        if (dmg >= target.hp) {
          score = 25000 + target.hp * 1000 + target.damage * 500;
          if (target.type === 'cavalry') score += 8000;
          if (target.type === 'archer') score += 6000;
          if (target.type === 'knight') score += 4000;
          if (target.hp < target.maxHp) score += 3000;
          if (isOwnPerspective && this.focusTarget && target.id === this.focusTarget) score += 5000;
          if (simUnit.type === 'archer' && this.config.archerKiteWeight > 0)
            score += 800 * this.config.archerKiteWeight;
          if (simUnit.type === 'cavalry' && this.config.cavalryFlankWeight > 0) {
            if (manhattan(lr, lc, target.row, target.col) >= 2)
              score += 1200 * this.config.cavalryFlankWeight;
          }
          const landingSafe = this.isSimPositionSafe(state, lr, lc, simUnit, target.id);
          if (!landingSafe) {
            const myVal = this.simUnitValue(simUnit);
            const targetVal = this.simUnitValue(target);
            const tradeDeficit = Math.max(0, myVal - targetVal);
            score -= Math.min(14000, 3000 + tradeDeficit * 0.4);
          }
        } else if (dmg > 0) {
          score = dmg * 800;
          if (target.armor > 0 && dmg >= target.armor) score += 2000;
          if (isOwnPerspective && this.focusTarget && target.id === this.focusTarget) score += 3000;
          // Graded, matching the move branch — otherwise trading a scratch for
          // the unit's life looks identical to a safe poke, and a threatened
          // archer prefers shooting (and dying) over retreating.
          const threat = this.simThreatAt(state, lr, lc, simUnit, null);
          if (threat > 0 && threat < simUnit.hp) score = Math.max(dmg * 300, score - threat * 600);
        } else {
          // dmg === 0: the shot bounces off the target's armour. This branch
          // used to leave score at 0, which beat every (negative) retreat — the
          // archer stood in a lethal envelope plinking for nothing. A no-op
          // attack is worth strictly less than repositioning.
          score = -500;
        }
        // Attacking from a square where we then die is a TRADE, not a blunder,
        // so this stays small — see the note in the move branch about pricing
        // death at full material value stalling the game out. Only charged when
        // the unit is not ALREADY doomed where it stands, otherwise a trapped
        // unit's best swing scores no better than standing idle.
        const standThreat = this.simThreatAt(state, lr, lc, simUnit, null);
        if (standThreat >= simUnit.hp && dmg < target.hp && !diesHere) score -= 3500;
        scored.push({
          type: 'attack',
          row: raw.row,
          col: raw.col,
          targetRow: raw.targetRow,
          targetCol: raw.targetCol,
          landingRow: lr,
          landingCol: lc,
          cost: raw.cost,
          score,
        });
      } else if (raw.type === 'move' && raw.row !== undefined && raw.col !== undefined) {
        let score = 0;
        let bestEnemyDist = Infinity;
        let currentBestDist = Infinity;
        enemies.forEach((e) => {
          const newDist = manhattan(raw.row!, raw.col!, e.row, e.col);
          const curDist = manhattan(simUnit.row, simUnit.col, e.row, e.col);
          if (newDist < bestEnemyDist) bestEnemyDist = newDist;
          if (curDist < currentBestDist) currentBestDist = curDist;
        });
        score += (currentBestDist - bestEnemyDist) * 400;
        if (simUnit.type === 'archer' || simUnit.type === 'crossbow') {
          // See the matching block in the other scorer: in range (Chebyshev-2,
          // i.e. manhattan 2-3), never in melee contact.
          if (bestEnemyDist === 2) score += 2500;
          else if (bestEnemyDist === 3) score += 1500;
          else if (bestEnemyDist === 1) score -= 1200;
        } else {
          if (bestEnemyDist === 1) score += 2000;
          if (bestEnemyDist === 2) score += 1200;
        }
        // C: castle approach — toward the ENEMY castle (see enemyCastleRow).
        if (this.config.castleApproachWeight > 0) {
          const backRank = this.enemyCastleRow(perspective);
          const distCur = Math.abs(simUnit.row - backRank);
          const distNew = Math.abs(raw.row - backRank);
          score += (distCur - distNew) * 250 * this.config.castleApproachWeight;
        }
        // Castle capture — the actual win condition, and until now invisible
        // here. evaluateLightState scores entering an undefended enemy castle at
        // +300000, but plans are BUILT by this mover-level scorer, which only
        // knew about creeping toward the back rank at 250/cell. A knight one
        // step below an open castle scored that step at 400 while an aimless
        // sideways shuffle scored 800 — so the winning move was never generated
        // as a candidate, and no amount of MCTS budget could pick a move the
        // planner never offered. Priced above every tactical term so it wins.
        const oppOf = otherPlayer(perspective);
        if (this.inCastleZone(raw.row, raw.col, oppOf)) {
          const defended = state.units.some(
            (u) => u.player !== perspective && u.hp > 0 && this.inCastleZone(u.row, u.col, oppOf),
          );
          score += defended ? 20000 : 200000;
        }
        // Symmetrically: stepping into our OWN castle when a raider is inside
        // (or closing on an empty one) is the defensive half of the same rule.
        if (this.inCastleZone(raw.row, raw.col, perspective)) {
          const raiderInside = state.units.some(
            (u) =>
              u.player !== perspective && u.hp > 0 && this.inCastleZone(u.row, u.col, perspective),
          );
          const otherDefender = state.units.some(
            (u) =>
              u.player === perspective &&
              u.hp > 0 &&
              u.id !== simUnit.id &&
              this.inCastleZone(u.row, u.col, perspective),
          );
          if (raiderInside) score += 30000;
          else if (!otherDefender && this.homeIsThreatened(state, perspective)) score += 12000;
        }
        if (getTowers().some((t) => t.row === raw.row && t.col === raw.col)) score += 2500;
        const rRow2 = raw.row ?? -1;
        const rCol2 = raw.col ?? -1;
        if (
          getAllRuins().some(
            (r) =>
              rRow2 >= r.top &&
              rRow2 < r.top + r.height &&
              rCol2 >= r.left &&
              rCol2 < r.left + r.width,
          )
        )
          score += 800;
        // E: knight tank.
        if (simUnit.type === 'knight' && this.config.knightTankWeight > 0) {
          const ranged = state.units.filter(
            (u) =>
              u.player === perspective &&
              u.hp > 0 &&
              u.id !== simUnit.id &&
              (u.type === 'archer' || u.type === 'cavalry'),
          );
          for (const a of ranged) {
            if (manhattan(raw.row, raw.col, a.row, a.col) === 1) {
              score += 700 * this.config.knightTankWeight;
              break;
            }
          }
        }
        // E: archer kite — in shooting range (manhattan 2-3), out of contact.
        if (
          (simUnit.type === 'archer' || simUnit.type === 'crossbow') &&
          this.config.archerKiteWeight > 0
        ) {
          const huggers = state.units.filter(
            (u) => u.player !== perspective && u.hp > 0 && u.type !== 'archer',
          );
          let minMeleeDist = 99;
          for (const h of huggers) {
            minMeleeDist = Math.min(minMeleeDist, manhattan(raw.row, raw.col, h.row, h.col));
          }
          if (bestEnemyDist >= 2 && bestEnemyDist <= 3 && minMeleeDist >= 2) {
            score += 1500 * this.config.archerKiteWeight;
          }
        }
        // Danger is priced RELATIVE to where the unit already stands, so a unit
        // that cannot escape is not charged for its own death wherever it goes,
        // and a unit that CAN escape is actively paid to do it.
        //
        // Magnitudes stay at the original -3500 scale on purpose. Pricing a
        // likely death at the unit's full material value reads as "correct",
        // but measured on the dense 10v10 opening it makes both sides refuse to
        // contest any square the enemy can reach: nothing dies for 10+ turns
        // and the game stalls to the turn limit.
        const threat = this.simThreatAt(state, raw.row, raw.col, simUnit, null);
        const diesThere = threat >= simUnit.hp;
        if (diesThere && !diesHere) score -= 3500;
        else if (!diesThere && diesHere) score += 3500;
        scored.push({
          type: 'move',
          row: raw.row,
          col: raw.col,
          cost: raw.cost,
          score,
        });
      }
    }
    return scored;
  }


  /**
   * Applies the end-of-turn transition: reset done/movesLeft for the next
   * player, decrement timed buffs for the ending player.
   */
  private applyEndOfTurn(state: LightState, endingPlayer: Player): LightState {
    const ns = this.cloneLightState(state);
    const next = otherPlayer(endingPlayer);
    ns.units.forEach((u) => {
      if (u.player === next && u.hp > 0) {
        u.done = false;
        u.movesLeft = u.maxMoves;
        u.activated = false; // fresh turn → fresh activation slots
        // Mage energy refills at the start of its own side's turn (Unit.resetTurn).
        if (u.type === 'mage') {
          u.energy = Math.min(MAGE_MAX_ENERGY, (u.energy ?? MAGE_MAX_ENERGY) + MAGE_ENERGY_REGEN_PER_TURN);
        }
      }
    });
    // The incoming side gets a full activation budget for its own turn.
    ns.activationsLeft = this.turnActivationCap();
    if (ns.shieldTurns[endingPlayer] > 0) ns.shieldTurns[endingPlayer] -= 1;
    if (ns.damageBuff[endingPlayer] > 0) ns.damageBuff[endingPlayer] -= 1;
    return ns;
  }

  /**
   * Canonical string hash of a LightState + player-to-move for the TT.
   * Sorted by unit id so repeated states from different action orders
   * collide as intended.
   */
  private lightStateHash(state: LightState, player: Player): string {
    const sorted = state.units
      .filter((u) => u.hp > 0)
      .map((u) => `${u.id}:${u.row}:${u.col}:${u.hp}:${u.armor}:${u.done ? 1 : 0}:${u.movesLeft}`)
      .sort()
      .join('|');
    const s1 = state.shieldTurns[1];
    const s2 = state.shieldTurns[2];
    const d1 = state.damageBuff[1];
    const d2 = state.damageBuff[2];
    return `${player}#${s1},${s2}#${d1},${d2}#${sorted}`;
  }

  /**
   * F: smart spell evaluator. Computes utility per spell with a proper
   * cost-benefit ratio, fixes the index-2 (damage buff) miscalibration in
   * the legacy `evaluateSpells`, and only emits a spell action when the
   * ratio passes a threshold.
   */
  private evaluateSpellsSmart(unit: Unit, actions: AIAction[]): void {
    const game = this.game;
    const inv = this.sideParts();
    const me = this.player;
    const allies = game.ownUnits(me).filter((a) => a.hp > 0);
    const enemies = game.ownUnits(otherPlayer(me));
    const threats = this.evaluateThreats();
    if (allies.length === 0) return;

    SPELLS.forEach((spell, index) => {
      if (!game.canAfford(inv, spell.recipe)) return;
      let utility = 0;

      if (index === 0) {
        // Heal +2 to all own units, capped at maxHp.
        const heal = allies.reduce((s, a) => s + Math.min(2, a.maxHp - a.hp), 0);
        utility = heal * 2500;
        const nearby = allies.filter((a) =>
          enemies.some((e) => manhattan(a.row, a.col, e.row, e.col) <= 3),
        ).length;
        utility += nearby * 800;
        // If a lethal threat would no-longer be lethal after heal — huge.
        threats.forEach((t) => {
          if (t.lethal && t.target.player === me && t.damage < t.target.hp + 2) utility += 6000;
        });
      } else if (index === 1) {
        // Armor restoration up to +2, capped at startArmor.
        const restored = allies.reduce(
          (s, a) => s + Math.min(2, Math.max(0, a.startArmor - a.armor)),
          0,
        );
        utility = restored * 2200;
        utility += threats.filter((t) => !t.lethal).length * 400;
        utility += allies.filter((a) => a.armor === 0 && a.startArmor > 0).length * 1500;
      } else if (index === 2) {
        // Damage buff +2 to all allies for 2 turns. Value = extra damage
        // that will actually be dealt (against current armor and HP).
        let extraDmg = 0;
        let newKills = 0;
        allies.forEach((a) => {
          const attackActs = game.attackActionsFor(a);
          attackActs.forEach((at) => {
            const target = game.board.unitAt(at.targetRow, at.targetCol);
            if (!target || target.player === me) return;
            const cur = game.computeDamage(a, target);
            const boosted = Math.max(0, a.damage + 2 - target.armor);
            const gain = Math.max(0, boosted - cur);
            extraDmg += gain;
            if (cur < target.hp && boosted >= target.hp) newKills += 1;
          });
        });
        utility = extraDmg * 1200 + newKills * 8000;
        // Buff lasts two turns, amortize.
        utility = Math.floor(utility * 1.5);
      }

      // Cost-benefit ratio gate: total artifact units in the recipe.
      let cost = 0;
      (Object.values(spell.recipe) as Array<number | undefined>).forEach((v) => {
        cost += v ?? 0;
      });
      const ratio = utility / Math.max(1, cost);
      if (ratio < 2000) return;

      if (this.config.spellReluctance > 0 && Math.random() < this.config.spellReluctance) return;

      // Mana opportunity-cost: if another spell becomes unaffordable after
      // this cast, discount by its potential utility (rough estimate).
      const futurePenalty = this.evaluateBestFutureSpell(inv, index);
      let score = utility;
      if (futurePenalty > utility * 1.5) score = Math.floor(utility * 0.4);

      actions.push({ type: 'spell', index, score });
    });
  }

  // ── Phase 3: MCTS ──────────────────────────────────────────────────────────
  //
  // Monte Carlo Tree Search with UCT selection and greedy rollouts.
  // Each tree node = one complete game state after a full turn.
  // Each edge = one player's complete turn-plan (generated via generateTopKTurnPlans).
  // Rollouts play out greedily for mctsRolloutDepth turns then evaluate.
  // Values are stored from ownPerspective (this.player) throughout the tree.

  private static now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Synchronous MCTS — runs the whole budget in one blocking call. Used by the
   *  minimax fallback paths. The interactive AI turn uses the time-sliced
   *  variant (mctsBegin/mctsSlice) so the screen doesn't freeze. */
  private mctsSearch(): PlanEntry[] {
    this.mctsBegin();
    while (!this.mctsSlice(1e9)) {
      /* run until the budget deadline is hit */
    }
    return this.mctsFinish();
  }

  // ── Off-thread search ──────────────────────────────────────────────────────
  // The worker runs the same MCTS; the main thread only kicks off a request and
  // polls for the result. If the worker is unavailable or fails, everything
  // falls back to the frame-sliced search with no behavioural difference beyond
  // the frame hitches it was introduced to remove.

  /** True when the off-thread search should be used for this turn. */
  private useWorkerSearch(): boolean {
    return AIPlayer.workerEnabled && isWorkerSupported();
  }

  /** Globally disable the worker (set when one fails, so we stop retrying). */
  private static workerEnabled = true;

  /** How much of the AI's plan the game actually executes, counted at the one
   *  place a planned action meets the real rules (performMove/performAttack).
   *  Read from the console via `window.__kcAIStats()`, and asserted on by
   *  tests/e2e/ai-illegal-moves.spec.ts. Non-zero `moveRejected` /
   *  `attackRejected` means the search's light-state generator and the real
   *  rules (@kc/game-rules) have drifted apart again — this class of bug has
   *  recurred three times (illegal move shapes, impassable terrain, a
   *  selectedUnit fast-path hijacking units away from their own plan). */
  static execStats: {
    moveOk: number;
    moveRejected: number;
    attackOk: number;
    attackRejected: number;
    log: string[];
    // How many 'attack' entries the PLAN itself contained, counted the moment
    // a turnPlan is built — before any execution, walk-forward skipping, or
    // moveMap/attackMap lookup can touch it. Compares against attackOk +
    // attackRejected to tell "the search never proposes an attack" apart from
    // "attacks are proposed but lost/rejected on the way to performAttack".
    plannedAttacks: number;
    plannedMoves: number;
  } = {
    moveOk: 0,
    moveRejected: 0,
    attackOk: 0,
    attackRejected: 0,
    log: [],
    plannedAttacks: 0,
    plannedMoves: 0,
  };

  /** Tally what a freshly built turnPlan actually contains, before a single
   *  entry is executed. Separates "the search never proposes an attack" from
   *  "attacks are proposed but lost on the way to performAttack". */
  private static tallyPlan(plan: PlanEntry[] | null): void {
    if (!plan) return;
    for (const e of plan) {
      if (e.action.type === 'attack') AIPlayer.execStats.plannedAttacks += 1;
      else if (e.action.type === 'move') AIPlayer.execStats.plannedMoves += 1;
    }
  }

  /** Impassable cells (river / mountain), as a row*COLS+col bitmap.
   *
   *  Board.isFree() rejects these, so the search must too. It is cached because
   *  the move generator runs millions of times per turn and getTerrain()
   *  returns an array that would otherwise be scanned on every candidate cell.
   *  Invalidated by identity: a new terrain array means a new map. */
  private static blockedTerrain: Uint8Array | null = null;
  private static blockedTerrainSrc: unknown = null;
  private static blockedConstructionsSrc: unknown = null;

  /** Mage tower at (row,col) — range bonus / damage penalty for ranged units. */
  private static isTowerCell(row: number, col: number): boolean {
    return getTowers().some((t) => t.row === row && t.col === col);
  }

  /** River water at (row,col); bridges are crossings, not water. */
  private static isRiverCell(row: number, col: number): boolean {
    return getTerrain().some((t) => t.row === row && t.col === col && t.type === 'river');
  }

  private static isBlockedTerrain(row: number, col: number): boolean {
    const terrain = getTerrain();
    const constructions = getConstructions();
    if (
      AIPlayer.blockedTerrainSrc !== terrain ||
      AIPlayer.blockedConstructionsSrc !== constructions ||
      AIPlayer.blockedTerrain === null
    ) {
      const map = new Uint8Array(ROWS * COLS);
      for (const t of terrain) {
        // River, mountain and catapult boulders block movement (see
        // Board.isFree). A cell is typed EITHER 'bridge' OR 'river', never
        // both, so bridges simply never appear here.
        if (t.type !== 'river' && t.type !== 'mountain' && t.type !== 'rock') continue;
        if (t.row >= 0 && t.row < ROWS && t.col >= 0 && t.col < COLS) map[t.row * COLS + t.col] = 1;
      }
      // Unfinished tower/bridge sites are impassable too.
      for (const c of constructions) {
        if (c.row >= 0 && c.row < ROWS && c.col >= 0 && c.col < COLS) map[c.row * COLS + c.col] = 1;
      }
      AIPlayer.blockedTerrain = map;
      AIPlayer.blockedTerrainSrc = terrain;
      AIPlayer.blockedConstructionsSrc = constructions;
    }
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
    return AIPlayer.blockedTerrain[row * COLS + col] === 1;
  }

  /**
   * Drive the off-thread search. Returns the finished plan, or null while the
   * search is still running (the caller should return and try again next frame).
   * On any worker failure this permanently falls back to the in-thread search.
   */
  private beamBusy = false;
  private beamPlan: PlanEntry[] | null = null;
  /** Bumped on reset so a search still running for an old game is ignored. */
  private beamGen = 0;

  /** The beam/rollout plan for this turn from the worker pool (null while thinking). */
  private consumeBeamPlan(): PlanEntry[] | null {
    if (this.beamPlan !== null) {
      const plan = this.beamPlan;
      this.beamPlan = null;
      this.beamBusy = false;
      this.thinkProgress = null;
      return plan;
    }
    if (this.beamBusy) {
      this.game.renderSidebar();
      return null;
    }
    const game = this.game;
    const beamConfig = BEAM_DIFFICULTY[this.config.useBeamSearch!];
    const tilt = PERSONALITIES[this.personality].weights;
    const weights = Object.keys(tilt).length ? scaleWeights(tilt, baseWeightsFor(beamConfig)) : undefined;
    if (!beamPoolSupported()) return beamPlanFor(game, this.player, beamConfig, weights);
    const state = snapshotGameState(game);
    const gen = ++this.beamGen;
    const toEntries = (actions: ServerAction[]): PlanEntry[] =>
      actions.map((a) => toPlanEntry(a, game.player1Bottom)).filter((e): e is PlanEntry => !!e);
    this.beamBusy = true;
    this.thinkProgress = 0;
    game.renderSidebar();
    planTurnInPool(state, this.player, beamConfig, state.turnNumber + 1, weights, (p) => {
      if (gen !== this.beamGen) return;
      this.thinkProgress = p;
      game.renderSidebar();
    })
      .then((actions) => {
        if (gen === this.beamGen) this.beamPlan = toEntries(actions);
      })
      .catch(() => {
        // A worker failed: plan on the main thread instead of stalling the turn.
        if (gen === this.beamGen) this.beamPlan = beamPlanFor(game, this.player, beamConfig, weights);
      });
    return null;
  }

  private consumeWorkerPlan(): PlanEntry[] | null {
    if (this.workerPlan !== null) {
      const plan = this.workerPlan;
      this.workerPlan = null;
      this.workerBusy = false;
      this.thinkProgress = null;
      return plan;
    }
    if (this.workerBusy) {
      this.game.renderSidebar(); // keep the progress bar animating
      return null;
    }
    // Start a new search for this turn.
    this.strategy = null;
    this.myTurnCount += 1;
    this.selectFocusTarget();
    this.workerBusy = true;
    this.thinkProgress = 0;
    this.game.renderSidebar();

    if (!this.searchWorker) this.searchWorker = new AISearchWorker();
    const state = this.createLightState();
    this.searchWorker
      .search({
        player: this.player,
        player1Bottom: this.game.player1Bottom,
        config: this.config,
        state: state as unknown as WorkerState,
        // Without this the worker's stub game reports no activation cap, and
        // the search plans turns three times longer than the game will run.
        maxActivatedPerTurn: this.game.maxActivatedPerTurn,
        onProgress: (p) => {
          this.thinkProgress = p;
          this.game.renderSidebar();
        },
      })
      .then((outcome) => {
        // Always land on a non-null plan. `workerBusy` is only cleared by the
        // `workerPlan !== null` branch above, so a null/undefined plan here
        // would leave the flag stuck true and every later frame would return
        // early — the bot freezes for the rest of the game and, because the
        // render loop keeps painting the last state, the board looks hung with
        // the previous unit's highlights still on it.
        this.workerPlan = (outcome?.plan as unknown as PlanEntry[]) ?? [];
        this.lastSearchStats = outcome?.stats ?? this.lastSearchStats;
      })
      .catch((err: unknown) => {
        // One failure is enough to distrust the worker for the rest of the
        // session; the in-thread search is always correct, just hitchier.
        console.warn('AI worker search failed; falling back to in-thread search.', err);
        AIPlayer.workerEnabled = false;
        this.searchWorker?.dispose();
        this.searchWorker = null;
        this.workerBusy = false;
        this.workerPlan = [];
      });
    return null;
  }

  /** Close out a finished think: record stats, hand the tree to the reuse slot,
   *  and clear the live search state. Returns the chosen plan. */
  private mctsFinish(): PlanEntry[] {
    const root = this.mctsRoot;
    const plan = this.mctsBestPlan();
    if (root) {
      this.lastSearchStats = {
        iterations: this.mctsIterations,
        reusedVisits: this.mctsReusedNodes,
        rootVisits: root.visits,
        rootChildren: root.children.length,
        maxDepth: AIPlayer.treeDepth(root),
        elapsedMs: this.mctsBudgetMs - Math.max(0, this.mctsDeadline - AIPlayer.now()),
        solved: root.solved,
      };
    }
    // Keep the tree so the NEXT turn can re-root into the grandchild matching
    // whatever the opponent actually played.
    this.mctsRetained = root;
    this.mctsRoot = null;
    this.thinkProgress = null;
    this.mctsReusedNodes = 0;
    return plan;
  }

  /** Depth of the deepest fully-expanded path — a search-quality signal for the
   *  bench (a wide, shallow tree means the budget went into plan generation). */
  private static treeDepth(root: MCTSNode): number {
    let depth = 0;
    let frontier: MCTSNode[] = [root];
    while (frontier.length > 0) {
      const next: MCTSNode[] = [];
      for (const n of frontier) {
        for (const c of n.children) if (c.visits > 0) next.push(c);
      }
      if (next.length === 0) break;
      depth += 1;
      frontier = next;
    }
    return depth;
  }

  /** Signature of a single planned action, used as the RAVE/AMAF key. Unlike
   *  planSignature (which fingerprints a whole turn-plan and therefore almost
   *  never repeats), this is shared between any two plans that happen to make
   *  the same unit do the same thing — which is exactly the statistic AMAF
   *  wants to pool. */
  private static actionKey(entry: PlanEntry): string {
    const a = entry.action;
    return `${entry.unitId}:${a.type}:${a.row ?? -1},${a.col ?? -1}:${a.targetRow ?? -1},${a.targetCol ?? -1}`;
  }

  /** Build a fresh tree node, computing the terminal-state cache once. */
  private mctsMakeNode(
    state: LightState,
    player: Player,
    parent: MCTSNode | null,
    parentPlan: PlanEntry[],
    ownPerspective: Player,
  ): MCTSNode {
    // Count once here rather than re-filtering the unit array on every descent.
    let myAlive = 0;
    let oppAlive = 0;
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      if (u.player === ownPerspective) myAlive += 1;
      else oppAlive += 1;
    }
    const terminal = myAlive === 0 || oppAlive === 0;
    const terminalValue = myAlive === 0 ? -1 : oppAlive === 0 ? 1 : 0;
    return {
      state,
      player,
      parent,
      parentPlan,
      children: [],
      visits: 0,
      totalValue: 0,
      value: terminal ? terminalValue : 0,
      terminal,
      terminalValue,
      solved: terminal,
      solvedValue: terminalValue,
      starters: null,
      starterIndex: 0,
      greedyTried: false,
      seenSignatures: new Set<string>(),
      amaf: null,
      planActionKeys: parentPlan.map((e) => AIPlayer.actionKey(e)),
    };
  }

  /** Start a fresh time-sliced MCTS think for the current position.
   *  Reuses the subtree carried over from the previous turn when the opponent's
   *  reply matches a state we already searched (see mctsTryReuse). */
  private mctsBegin(): void {
    const state = this.createLightState();
    this.mctsRoot = this.mctsTryReuse(state) ?? this.mctsMakeNode(state, this.player, null, [], this.player);
    this.mctsBudgetMs = Math.max(1, this.scaleBudget(this.config.mctsTimeBudgetMs));
    this.mctsDeadline = AIPlayer.now() + this.mctsBudgetMs;
    this.thinkProgress = 0;
    this.mctsIterations = 0;
  }

  /** Tree reuse: after our move and the opponent's reply, the resulting position
   *  is usually a grandchild of last turn's root — a subtree we already spent a
   *  full budget searching. Re-rooting there keeps that statistic instead of
   *  throwing it away and starting from zero every turn. */
  private mctsTryReuse(state: LightState): MCTSNode | null {
    const prev = this.mctsRetained;
    this.mctsRetained = null;
    if (!prev) return null;
    const wanted = this.lightStateHash(state, this.player);
    for (const child of prev.children) {
      for (const grand of child.children) {
        if (grand.player !== this.player) continue;
        if (this.lightStateHash(grand.state, grand.player) !== wanted) continue;
        // Detach from the old tree so the discarded branches can be collected.
        grand.parent = null;
        grand.parentPlan = [];
        grand.planActionKeys = [];
        this.mctsReusedNodes = grand.visits;
        return grand;
      }
    }
    return null;
  }

  /** Run MCTS iterations for up to `sliceMs` (or until the overall deadline).
   *  Updates thinkProgress. Returns true when the whole think is finished. */
  private mctsSlice(sliceMs: number): boolean {
    const me = this.player;
    const root = this.mctsRoot;
    if (!root) return true;
    const sliceEnd = Math.min(AIPlayer.now() + sliceMs, this.mctsDeadline);
    // The batch exists only to amortise now(); it must never overshoot the
    // deadline. One iteration can cost tens of milliseconds (an expansion runs a
    // full greedy turn, a rollout runs up to 16 of them), so a fixed batch of 16
    // could blow past the slice by seconds and freeze the frame. Size the batch
    // from the measured cost of recent iterations instead.
    while (AIPlayer.now() < sliceEnd) {
      if (root.solved) break; // proven result — more rollouts cannot change it
      const batch = Math.max(1, Math.min(64, Math.round(AIPlayer.BATCH_TARGET_MS / this.mctsIterCostMs)));
      const t0 = AIPlayer.now();
      let ran = 0;
      for (let i = 0; i < batch; i += 1) {
        if (root.solved) break;
        this.mctsIteration(root, me);
        ran += 1;
      }
      const elapsed = AIPlayer.now() - t0;
      if (ran > 0) {
        // Exponential moving average keeps the estimate stable across the wildly
        // varying cost of expansion-heavy vs rollout-only iterations.
        const per = Math.max(0.001, elapsed / ran);
        this.mctsIterCostMs = this.mctsIterCostMs * 0.7 + per * 0.3;
        this.mctsIterations += ran;
      }
    }
    const remaining = this.mctsDeadline - AIPlayer.now();
    this.thinkProgress = Math.max(0, Math.min(1, 1 - remaining / this.mctsBudgetMs));
    return remaining <= 0 || root.solved;
  }

  /** One select → expand → rollout → backprop cycle. */
  private mctsIteration(root: MCTSNode, me: Player): void {
    const leaf = this.mctsSelect(root, me);
    let evalNode = leaf;
    // mctsSelect only stops at a non-terminal node when that node still has room
    // to widen, so expand unconditionally here. (Gating this on visits > 0 — as
    // the pre-Progressive-Widening code did — starves the tree: the node absorbs
    // the rollout, its visit count grows, allowedChildren grows with it, and the
    // search keeps re-selecting the same node to widen instead of descending.)
    if (!leaf.terminal) {
      const expanded = this.mctsExpand(leaf, me);
      if (expanded) evalNode = expanded;
    }
    const rolloutKeys = this.config.useRAVE ? new Set<string>() : null;
    const value = evalNode.terminal
      ? evalNode.terminalValue
      : this.mctsRollout(evalNode.state, evalNode.player, me, rolloutKeys);
    this.mctsBackprop(evalNode, value, rolloutKeys);
  }

  /** The plan to actually play. Normally the most-visited root child (the most
   *  robust choice). When mctsSelectionTemp > 0 the choice is SAMPLED from
   *  visits^(1/T) instead — difficulty scaling by adding noise weighted by how
   *  strong each node proved to be, rather than by degrading the search. */
  private mctsBestPlan(): PlanEntry[] {
    const root = this.mctsRoot;
    if (!root || root.children.length === 0) return [];
    // A proven win overrides everything else — take it immediately.
    const proven = root.children.find((c) => c.solved && c.solvedValue > 0);
    if (proven) return proven.parentPlan;

    const temp = this.config.mctsSelectionTemp ?? 0;
    const usable = root.children.filter((c) => c.visits > 0 && !(c.solved && c.solvedValue < 0));
    const pool = usable.length > 0 ? usable : root.children;
    if (temp <= 0 || pool.length === 1) {
      return pool.reduce((a, b) => (a.visits > b.visits ? a : b)).parentPlan;
    }
    const weights = pool.map((c) => Math.pow(Math.max(c.visits, 1), 1 / temp));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total) || total <= 0) {
      return pool.reduce((a, b) => (a.visits > b.visits ? a : b)).parentPlan;
    }
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i += 1) {
      r -= weights[i]!;
      if (r <= 0) return pool[i]!.parentPlan;
    }
    return pool[pool.length - 1]!.parentPlan;
  }

  /** How many children a node has earned. Progressive Widening: a node with N
   *  visits may hold k·N^alpha children, capped by mctsBreadth. Cheap branches
   *  stay narrow (1 plan generated) while the main line widens as it proves
   *  worth the cost — which is what makes a large breadth cap affordable. */
  private allowedChildren(node: MCTSNode): number {
    const cap = Math.max(1, this.config.mctsBreadth);
    const alpha = this.config.pwAlpha ?? 0.45;
    if (alpha <= 0) return cap; // widening disabled → old fixed-breadth behaviour
    const k = this.config.pwK ?? 1.5;
    return Math.max(1, Math.min(cap, Math.floor(k * Math.pow(Math.max(node.visits, 1), alpha))));
  }

  private mctsSelect(node: MCTSNode, ownPerspective: Player): MCTSNode {
    for (;;) {
      if (node.terminal) return node;

      // Room to widen (and plans still available) → expand here.
      if (node.children.length < this.allowedChildren(node) && !this.mctsExhausted(node)) return node;

      // Nothing to descend into (no legal turn-plans at all) → leaf.
      if (node.children.length === 0) return node;

      const best = this.mctsBestChild(node, ownPerspective);
      if (!best) return node;
      node = best;
    }
  }

  /** The value of a node, always from ownPerspective.
   *
   *  Plain UCT averages rollout results, which is only sound when each node's
   *  statistic is stored from the point of view of the player to move and is
   *  negated every ply. This tree instead stores every value from ONE fixed
   *  perspective (this.player), so a raw average at an opponent node silently
   *  assumes the opponent picks a random reply rather than their best one. In a
   *  sharp tactical position that washes out the refutation: a node whose
   *  children score 0.24, 0.02, 0.24, 0.24 averages to ~0.20 even though the
   *  opponent would obviously play the 0.02 line.
   *
   *  So we blend the average with the minimax backup of the children: as a node
   *  accumulates visits its value converges to "what the mover would actually
   *  choose", which is what makes the search see forced replies. Unvisited and
   *  shallow nodes keep the average, preserving MCTS's exploration behaviour. */
  private nodeValue(node: MCTSNode): number {
    if (node.solved) return node.solvedValue;
    if (node.visits === 0) return 0;
    return node.value;
  }

  /** Recompute one node's cached value from its own average and its children's
   *  already-cached values. Called bottom-up in backprop, so the whole tree stays
   *  consistent for O(depth) per iteration rather than O(tree) per lookup. */
  private refreshValue(node: MCTSNode): void {
    if (node.solved) {
      node.value = node.solvedValue;
      return;
    }
    if (node.visits === 0) {
      node.value = 0;
      return;
    }
    const avg = node.totalValue / node.visits;
    if (this.config.flatBackup) {
      node.value = avg; // A/B only: the old plain-averaging behaviour.
      return;
    }
    const moverIsMe = node.player === this.player;
    let best = moverIsMe ? -Infinity : Infinity;
    let seen = 0;
    for (const child of node.children) {
      if (child.visits === 0) continue;
      const v = child.solved ? child.solvedValue : child.value;
      if (moverIsMe) {
        if (v > best) best = v;
      } else if (v < best) best = v;
      seen += 1;
    }
    if (seen === 0) {
      node.value = avg;
      return;
    }
    // Confidence in the minimax backup grows with how well the children have
    // been sampled; below that it stays an average so exploration still works.
    const w = Math.min(1, node.visits / (node.visits + 24));
    node.value = (1 - w) * avg + w * best;
  }

  /** UCT (optionally blended with RAVE) over a node's existing children. */
  private mctsBestChild(node: MCTSNode, ownPerspective: Player): MCTSNode | null {
    const isMax = node.player === ownPerspective;
    const logN = Math.log(Math.max(1, node.visits));
    const c = this.config.mctsExploration ?? Math.SQRT2;
    const useRave = this.config.useRAVE === true && node.amaf !== null;
    const bias = this.config.raveBias ?? AIPlayer.DEFAULT_RAVE_BIAS;
    let best: MCTSNode | null = null;
    let bestScore = -Infinity;
    for (const child of node.children) {
      // An unvisited child is always tried first — it has no statistic yet.
      if (child.visits === 0) return child;
      // Skip branches already proven lost for whoever is choosing here.
      if (child.solved) {
        const good = isMax ? child.solvedValue > 0 : child.solvedValue < 0;
        if (good) return child; // proven best for the mover — take it
      }
      let value = this.nodeValue(child);
      if (useRave) {
        // Pool the AMAF estimate of every action in this child's plan.
        let amafVisits = 0;
        let amafValue = 0;
        for (const key of child.planActionKeys) {
          const rec = node.amaf!.get(key);
          if (rec) {
            amafVisits += rec.visits;
            amafValue += rec.value;
          }
        }
        if (amafVisits > 0) {
          const n = child.visits;
          // Standard Gelly–Silver schedule: AMAF dominates while the true
          // statistic is thin, and decays out as real visits accumulate.
          const beta = amafVisits / (amafVisits + n + 4 * amafVisits * n * bias * bias);
          value = (1 - beta) * value + beta * (amafValue / amafVisits);
        }
      }
      // isMax: maximise value (my perspective). isMin: the opponent picks the
      // line that is worst for me, i.e. maximises -value.
      const exploit = isMax ? value : -value;
      const uct = exploit + c * Math.sqrt(logN / child.visits);
      if (uct > bestScore) {
        bestScore = uct;
        best = child;
      }
    }
    return best;
  }

  /** True when a node has no further candidate plans to turn into children. */
  private mctsExhausted(node: MCTSNode): boolean {
    if (node.starters === null) return false; // not computed yet — plans may exist
    if (!node.greedyTried) return false;
    return node.starterIndex >= node.starters.length;
  }

  /** Add exactly ONE child to `node`. Plans are produced lazily: computing the
   *  cheap per-unit action scores once, then paying for a full greedy turn
   *  simulation only for the starter being expanded right now. The old code
   *  generated all K plans on first touch, which cost K greedy turns before the
   *  first rollout and made every node expensive whether or not it was ever
   *  revisited. */
  private mctsExpand(node: MCTSNode, ownPerspective: Player): MCTSNode | null {
    if (node.starters === null) {
      node.starters = this.computePlanStarters(node.state, node.player);
    }
    for (;;) {
      let plan: PlanEntry[];
      let endState: LightState;
      if (!node.greedyTried) {
        // The unseeded greedy turn is always the first candidate: it is the
        // engine's own best guess and a guaranteed-legal fallback.
        node.greedyTried = true;
        const greedy = this.completeTurnGreedy(node.state, node.player, null);
        plan = greedy.plan;
        endState = greedy.endState;
      } else if (node.starterIndex < node.starters.length) {
        const s = node.starters[node.starterIndex]!;
        node.starterIndex += 1;
        const completed = this.completeTurnGreedy(node.state, node.player, {
          unitId: s.unitId,
          action: s.action,
        });
        plan = completed.plan;
        endState = completed.endState;
      } else {
        return null; // no candidates left
      }
      if (plan.length === 0) continue;
      const sig = this.planSignature(plan);
      if (node.seenSignatures.has(sig)) continue; // collapsed onto an existing child
      node.seenSignatures.add(sig);

      const nextState = this.applyEndOfTurn(endState, node.player);
      const child = this.mctsMakeNode(
        nextState,
        otherPlayer(node.player),
        node,
        plan,
        ownPerspective,
      );
      node.children.push(child);
      return child;
    }
  }

  /** Score every (unit, action) pair once so expansion can pick starters lazily.
   *  This is the cheap half of the old generateTopKTurnPlans — no greedy turn
   *  simulation happens here. */
  private computePlanStarters(state: LightState, player: Player): PlanStarter[] {
    const candidates = state.units.filter(
      (u) =>
        u.player === player &&
        u.hp > 0 &&
        !u.done &&
        u.movesLeft > 0 &&
        // Only units that already activated, or a fresh one while slots remain.
        (u.activated || state.activationsLeft > 0),
    );
    if (candidates.length === 0) return [];
    const starters: PlanStarter[] = [];
    candidates.forEach((u) => {
      const raw = this.generateActionsForLightState(state, u);
      const scored = this.scoreLightActions(state, u, raw, player);
      // Top-3 actions per unit keeps the candidate list diverse without letting
      // one unit's near-duplicate moves crowd out every other unit.
      scored.slice(0, 3).forEach((a) => {
        if (a.type !== 'skip') starters.push({ unitId: u.id, action: a, score: a.score ?? 0 });
      });
    });
    if (this.nnActive) this.applyNNPolicyPrior(state, player, starters);
    starters.sort((a, b) => b.score - a.score);
    return starters;
  }

  /** Fixed-width feature vector for ONE candidate (unit, action) pair, read by
   *  the policy head (see nn-eval.ts's policyLogit). Kept tiny and hand-picked
   *  rather than trying to describe the action exhaustively — the trunk's
   *  hidden state already carries the full board, so this only needs to say
   *  "which of the position's many options is this one". */
  private static readonly POLICY_ACTION_FEATURE_WIDTH = 8;
  private encodeActionFeatures(state: LightState, unit: LightUnit, action: AIAction): number[] {
    const isAttack = action.type === 'attack' ? 1 : 0;
    const isMove = action.type === 'move' ? 1 : 0;
    const isOther = isAttack || isMove ? 0 : 1;
    const target =
      action.type === 'attack' && action.targetRow !== undefined && action.targetCol !== undefined
        ? state.units.find((u) => u.row === action.targetRow && u.col === action.targetCol && u.hp > 0)
        : null;
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    const targetHpFrac = target ? clamp01(target.hp / Math.max(1, target.maxHp)) : 0;
    // Same plain damage approximation used ad hoc throughout this file
    // (e.g. line ~2982): attacker damage minus target armor, floored at 0.
    // Good enough for a policy-ranking feature — the exact combat.ts formula
    // (crits, shields, etc.) isn't needed just to say "this attack looks lethal".
    const approxDamage = target ? Math.max(0, unit.damage - target.armor) : 0;
    const lethal = target && approxDamage >= target.hp ? 1 : 0;
    const destRow = action.row ?? unit.row;
    const destCol = action.col ?? unit.col;
    const moveDist = clamp01(Math.abs(destRow - unit.row) / 6 + Math.abs(destCol - unit.col) / 6);
    const enemyCastleRow = this.enemyCastleRow(unit.player);
    const advanceTowardCastle = clamp01(1 - Math.abs(destRow - enemyCastleRow) / 20);
    return [isAttack, isMove, isOther, targetHpFrac, lethal, moveDist, advanceTowardCastle, unit.movesLeft / 4];
  }

  /** Blend the net's policy head into the heuristic starter scores: each
   *  candidate's score is nudged by log(policy probability), so a strongly
   *  preferred-by-the-net action is ranked earlier without the hand-tuned
   *  heuristic being discarded outright (useful while the net is still weak
   *  early in training — see neuralNetBlend for the analogous value-side
   *  hedge). Scaled by W.rollout.staticEvalScale so the nudge sits on the same
   *  order of magnitude as the heuristic scores it's adjusting. */
  private applyNNPolicyPrior(state: LightState, player: Player, starters: PlanStarter[]): void {
    if (starters.length === 0) return;
    const evaluator = this.nnEvaluator!;
    const orientation: BoardOrientation = { player1Bottom: this.game.player1Bottom };
    const hidden = evaluator.evaluate(state, player, orientation).hidden;
    const features = starters.map((s) => {
      const unit = state.units.find((u) => u.id === s.unitId);
      return unit ? this.encodeActionFeatures(state, unit, s.action) : new Array(AIPlayer.POLICY_ACTION_FEATURE_WIDTH).fill(0);
    });
    const logits = evaluator.policyLogitsFor(hidden, features);
    const probs = softmax(logits);
    const nudgeScale = W.rollout.staticEvalScale * 0.5;
    starters.forEach((s, i) => {
      const p = Math.max(1e-6, probs[i] ?? 1e-6);
      s.score += Math.log(p) * nudgeScale;
    });
  }

  private mctsRollout(
    state: LightState,
    startPlayer: Player,
    ownPerspective: Player,
    rolloutKeys: Set<string> | null = null,
  ): number {
    let cur = this.cloneLightState(state);
    let player = startPlayer;
    const opp = otherPlayer(ownPerspective);

    // Depth-discounted terminal reward: a win/loss that happens SOONER is worth
    // more (0.97^d), so the search prefers the fastest kill and the most-delayed
    // loss — sharpening the signal so extra rollouts actually discriminate.
    const reward = (win: boolean, d: number): number =>
      (win ? 1 : -1) * Math.pow(W.rollout.terminalDiscount, d);

    // ── AlphaZero-style leaf evaluation ───────────────────────────────────
    // When a trained net is active, skip the greedy multi-turn playout below
    // entirely: the value head is trained (via self-play outcomes) to already
    // encode what that playout used to approximate, in one forward pass instead
    // of up to 16 simulated turns. Still check the immediate terminal
    // conditions first — those are exact facts about `state`, not something a
    // net trained on non-terminal positions should be asked to estimate.
    if (this.nnActive) {
      const myAliveNow = cur.units.filter((u) => u.player === ownPerspective && u.hp > 0).length;
      const oppAliveNow = cur.units.filter((u) => u.player !== ownPerspective && u.hp > 0).length;
      if (myAliveNow === 0) return reward(false, 0);
      if (oppAliveNow === 0) return reward(true, 0);
      const meInCastleNow = cur.units.some(
        (u) => u.player === ownPerspective && u.hp > 0 && this.inCastleZone(u.row, u.col, opp),
      );
      const oppDefendsNow = cur.units.some(
        (u) => u.player === opp && u.hp > 0 && this.inCastleZone(u.row, u.col, opp),
      );
      if (meInCastleNow && !oppDefendsNow) return reward(true, 0);
      const oppInCastleNow = cur.units.some(
        (u) => u.player === opp && u.hp > 0 && this.inCastleZone(u.row, u.col, ownPerspective),
      );
      const meDefendsNow = cur.units.some(
        (u) => u.player === ownPerspective && u.hp > 0 && this.inCastleZone(u.row, u.col, ownPerspective),
      );
      if (oppInCastleNow && !meDefendsNow) return reward(false, 0);

      const orientation: BoardOrientation = { player1Bottom: this.game.player1Bottom };
      const netValue = this.nnEvaluator!.value(cur, ownPerspective, orientation);
      const blend = this.config.neuralNetBlend ?? 0;
      if (blend <= 0) return netValue;
      const staticValue = Math.tanh(this.evaluateLightState(cur, ownPerspective) / W.rollout.staticEvalScale);
      return netValue * (1 - blend) + staticValue * blend;
    }

    // Rollout depth is taken from the config AS WRITTEN — it deliberately does
    // NOT scale with iq.
    //
    // It used to: scaleSearch turned hard's mctsRolloutDepth of 10 into 28,
    // which then clamped to the hard cap of 16. Every iteration therefore
    // simulated 16 full greedy turns at ~0.19 ms each, so one iteration cost
    // ~2.8 ms and hard's whole 12 s budget bought only ~4500 iterations across
    // 18 root children — about 250 samples per candidate plan, which is far too
    // few for the statistics to mean anything. Measured head-to-head at EQUAL
    // wall-clock (iq 1 @2000ms vs iq 8 @250ms×8): iq 1 won both sides, 2-0.
    //
    // A greedy playout is a crude policy for both sides, so its signal decays
    // fast with length; past a handful of turns the extra plies are noise that
    // costs linearly more. The time budget still scales with iq (scaleBudget),
    // so a higher iq now buys MORE rollouts rather than longer ones.
    const rolloutDepth = Math.max(1, Math.min(16, this.config.mctsRolloutDepth));
    for (let d = 0; d < rolloutDepth; d += 1) {
      const myAlive = cur.units.filter((u) => u.player === ownPerspective && u.hp > 0).length;
      const oppAlive = cur.units.filter((u) => u.player !== ownPerspective && u.hp > 0).length;
      if (myAlive === 0) return reward(false, d);
      if (oppAlive === 0) return reward(true, d);
      // Castle capture is the REAL win condition — recognise it in rollouts so
      // the search values "get into their undefended castle", not just wipeouts.
      const meInEnemyCastle = cur.units.some(
        (u) => u.player === ownPerspective && u.hp > 0 && this.inCastleZone(u.row, u.col, opp),
      );
      const oppDefends = cur.units.some(
        (u) => u.player === opp && u.hp > 0 && this.inCastleZone(u.row, u.col, opp),
      );
      if (meInEnemyCastle && !oppDefends) return reward(true, d);
      const oppInMyCastle = cur.units.some(
        (u) => u.player === opp && u.hp > 0 && this.inCastleZone(u.row, u.col, ownPerspective),
      );
      const meDefends = cur.units.some(
        (u) => u.player === ownPerspective && u.hp > 0 && this.inCastleZone(u.row, u.col, ownPerspective),
      );
      if (oppInMyCastle && !meDefends) return reward(false, d);

      // Only the OPPONENT's simulated turns are noisy. Our own playout stays
      // greedy: noise on our side would just add variance to the estimate of a
      // plan we are going to choose deliberately anyway.
      const { plan, endState } = this.completeTurnGreedy(
        cur,
        player,
        null,
        0,
        player !== ownPerspective,
      );
      // AMAF: remember which of OUR actions occurred anywhere in this playout,
      // so their statistic can be credited to every sibling plan that also
      // contains them — that is the "all moves as first" pooling.
      if (rolloutKeys && player === ownPerspective) {
        for (const entry of plan) rolloutKeys.add(AIPlayer.actionKey(entry));
      }
      cur = this.applyEndOfTurn(endState, player);
      player = otherPlayer(player);
    }

    // Final terminal check before static eval.
    const myAlive = cur.units.filter((u) => u.player === ownPerspective && u.hp > 0).length;
    const oppAlive = cur.units.filter((u) => u.player !== ownPerspective && u.hp > 0).length;
    if (myAlive === 0) return -1;
    if (oppAlive === 0) return 1;

    // Normalise static evaluation to (-1, 1) so it's commensurate with
    // terminal rewards.  tanh squashes large material leads to ≈ ±1.
    return Math.tanh(this.evaluateLightState(cur, ownPerspective) / W.rollout.staticEvalScale);
  }

  private mctsBackprop(node: MCTSNode, value: number, rolloutKeys: Set<string> | null): void {
    // The action keys credited by AMAF are those played on the path from the
    // node upward, plus everything our side did in the playout itself.
    const amafKeys = rolloutKeys;
    let cur: MCTSNode | null = node;
    while (cur !== null) {
      cur.visits += 1;
      cur.totalValue += value;

      const parent: MCTSNode | null = cur.parent;
      if (parent) {
        if (amafKeys) {
          // Credit this node's own plan actions too: from the parent's point of
          // view they were "played below here" just like the rollout's actions.
          if (parent.player === this.player) {
            for (const key of cur.planActionKeys) amafKeys.add(key);
          }
          if (parent.amaf === null) parent.amaf = new Map();
          for (const key of amafKeys) {
            const rec = parent.amaf.get(key);
            if (rec) {
              rec.visits += 1;
              rec.value += value;
            } else {
              parent.amaf.set(key, { visits: 1, value });
            }
          }
        }
        this.mctsUpdateSolved(parent);
      }
      // Refresh AFTER the children are final, so the minimax backup at `cur`
      // sees up-to-date child values before its own parent consumes it.
      this.refreshValue(cur);
      cur = parent;
    }
  }

  /** MCTS-Solver propagation. A node is PROVEN once the game-theoretic result is
   *  forced: the mover can prove a win if any child is a proven win for them,
   *  and is proven lost only when every child (and there are no unexpanded ones
   *  left) is a proven loss. Solved subtrees stop consuming rollouts — without
   *  this the search keeps re-sampling branches whose outcome is already known. */
  private mctsUpdateSolved(node: MCTSNode): void {
    if (node.solved || node.children.length === 0) return;
    const moverIsMe = node.player === this.player;
    // A proven win for whoever moves here.
    for (const child of node.children) {
      if (!child.solved) continue;
      const winForMover = moverIsMe ? child.solvedValue > 0 : child.solvedValue < 0;
      if (winForMover) {
        node.solved = true;
        node.solvedValue = child.solvedValue;
        return;
      }
    }
    // A proven loss requires the node to be fully expanded AND every child lost.
    if (!this.mctsExhausted(node)) return;
    if (node.children.length < this.allowedChildren(node)) return;
    let allSolved = true;
    let worst = moverIsMe ? 1 : -1;
    for (const child of node.children) {
      if (!child.solved) {
        allSolved = false;
        break;
      }
      // The mover picks their best; if all are losses, the best loss stands.
      if (moverIsMe) worst = Math.max(worst === 1 ? -1 : worst, child.solvedValue);
      else worst = Math.min(worst === -1 ? 1 : worst, child.solvedValue);
    }
    if (allSolved) {
      node.solved = true;
      node.solvedValue = worst;
    }
  }

  /**
   * Order-INDEPENDENT signature: the same set of actions in a different order
   * hashes the same.
   *
   * Candidate plans are built by fixing a different starter action and then
   * completing greedily, so "cavalry moves, then knight moves" and "knight
   * moves, then cavalry moves" came out as two distinct candidates with
   * identical end states. Measured on a middlegame cluster, 9 generated plans
   * collapsed to 3 distinct first actions and one single greedy tail — the
   * search was spending its whole budget re-evaluating permutations of one
   * turn. Deduping on the SET frees that budget for genuinely different turns.
   *
   * The end state is what the search evaluates, and it is order-independent for
   * these plans, so collapsing them loses nothing.
   */
  private planSetSignature(plan: PlanEntry[]): string {
    return plan
      .map((p) =>
        [
          p.unitId,
          p.action.type,
          p.action.row ?? -1,
          p.action.col ?? -1,
          p.action.targetRow ?? -1,
          p.action.targetCol ?? -1,
          p.action.index ?? -1,
        ].join(','),
      )
      .sort()
      .join(';');
  }

  private planSignature(plan: PlanEntry[]): string {
    return plan
      .map((p) =>
        [
          p.unitId,
          p.action.type,
          p.action.row ?? -1,
          p.action.col ?? -1,
          p.action.targetRow ?? -1,
          p.action.targetCol ?? -1,
        ].join(','),
      )
      .join(';');
  }
}

// Re-export weapon type so callers building PendingWeaponEquip can use a
// proper named import.
export type { UnitWeapon };
