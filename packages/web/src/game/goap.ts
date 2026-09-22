/**
 * GOAP (Goal-Oriented Action Planning) strategic layer.
 *
 * Replaces the hardcoded stage ladder in ai.ts's computeStrategy() /
 * applyStrategicOverlay() with a small STRIPS-style planner: actions carry
 * preconditions + effects, a goal is picked by numeric insistence (Utility AI
 * style), and a short backward-chaining search finds the next action to take
 * toward it. See /Users/free/.claude/plans/happy-beaming-cosmos.md for the
 * full design rationale (why backward-chaining and not A*, why Utility AI for
 * goal selection, the phased rollout).
 *
 * Pure functions only — no `this`, no dependency on AIPlayer or the live
 * board. ai.ts imports this module; this module never imports from ai.ts.
 */

// ── World state ──────────────────────────────────────────────────────────

export type ForceRatioBucket = 'behind' | 'even' | 'ahead';

/** Small derived snapshot of the facts computeStrategy() used to read
 *  directly off the board. Deriving these stays ai.ts's job (it already has
 *  the board/unit access); this module only reasons over the result. */
export interface WorldState {
  sallyDone: boolean;
  weHoldRuins: boolean;
  ruinsContested: boolean;
  ruinsTimedOut: boolean;
  weHoldBridge: boolean;
  wellArmed: boolean;
  forceRatioBucket: ForceRatioBucket;
  enemyNearOurDoor: boolean;
  weAreInEnemyCastle: boolean;
  enemyDefendersPresent: boolean;
  enemyCastleEmpty: boolean;
}

export function deriveWorldState(facts: WorldState): WorldState {
  // Currently a passthrough — kept as a named entry point so ai.ts has one
  // stable place to call, and so future derived/smoothed facts (e.g.
  // hysteresis) have a home without changing every call site.
  return facts;
}

// ── Actions ───────────────────────────────────────────────────────────────

export interface GoapAction {
  name: StrategyStageName;
  pre: (s: WorldState) => boolean;
  effect: (s: WorldState) => WorldState;
  cost: number;
}

/** Mirrors StrategyStage in ai.ts (kept as a separate type here so this
 *  module has zero import from ai.ts; ai.ts maps 1:1 between the two). */
export type StrategyStageName =
  | 'sally'
  | 'take-ruins'
  | 'hold-bridge'
  | 'arm-up'
  | 'march'
  | 'assault'
  | 'mop-up'
  | 'defend';

const leaveCastle: GoapAction = {
  name: 'sally',
  pre: (s) => !s.sallyDone,
  effect: (s) => ({ ...s, sallyDone: true }),
  cost: 1,
};

const captureRuins: GoapAction = {
  name: 'take-ruins',
  pre: (s) => s.sallyDone && !s.weHoldRuins && !s.ruinsTimedOut,
  effect: (s) => ({ ...s, weHoldRuins: true }),
  cost: 1,
};

const holdBridge: GoapAction = {
  name: 'hold-bridge',
  pre: (s) => (s.weHoldRuins || s.ruinsTimedOut) && !s.weHoldBridge,
  effect: (s) => ({ ...s, weHoldBridge: true }),
  cost: 1,
};

const armUp: GoapAction = {
  name: 'arm-up',
  pre: (s) => s.weHoldRuins && !s.wellArmed,
  effect: (s) => ({ ...s, wellArmed: true }),
  cost: 1,
};

const advanceToEnemyCastle: GoapAction = {
  name: 'march',
  pre: (s) => s.wellArmed && s.weHoldBridge && !s.weAreInEnemyCastle,
  effect: (s) => ({ ...s, weAreInEnemyCastle: true }),
  cost: 1,
};

const assaultCastle: GoapAction = {
  name: 'assault',
  pre: (s) =>
    !s.weAreInEnemyCastle &&
    !s.enemyDefendersPresent &&
    (s.weAreInEnemyCastle || s.forceRatioBucket !== 'behind'),
  effect: (s) => ({ ...s, weAreInEnemyCastle: true }),
  cost: 1,
};

const mopUpCastle: GoapAction = {
  name: 'mop-up',
  pre: (s) => s.weAreInEnemyCastle && s.enemyDefendersPresent,
  effect: (s) => ({ ...s, enemyDefendersPresent: false }),
  cost: 1,
};

const defendHome: GoapAction = {
  name: 'defend',
  pre: (s) => s.enemyNearOurDoor && s.forceRatioBucket !== 'ahead' && !s.sallyDone,
  effect: (s) => ({ ...s, enemyNearOurDoor: false }),
  cost: 0, // cheapest — an emergency always wins backward-chaining ties
};

export const ACTIONS: GoapAction[] = [
  defendHome,
  leaveCastle,
  captureRuins,
  holdBridge,
  armUp,
  advanceToEnemyCastle,
  assaultCastle,
  mopUpCastle,
];

// ── Goals ─────────────────────────────────────────────────────────────────

export interface GoapGoal {
  name: 'SecureHome' | 'WinByCastle';
  satisfied: (s: WorldState) => boolean;
  insistence: (s: WorldState) => number;
}

/** Home is under threat and we are not clearly ahead — spike above WinByCastle. */
const secureHome: GoapGoal = {
  name: 'SecureHome',
  satisfied: (s) => !s.enemyNearOurDoor || s.forceRatioBucket === 'ahead',
  insistence: (s) => (s.enemyNearOurDoor && s.forceRatioBucket !== 'ahead' ? 100 : 0),
};

/** The baseline goal: win by taking and holding the enemy castle. Always live
 *  at some insistence so there is always a fallback plan. */
const winByCastle: GoapGoal = {
  name: 'WinByCastle',
  satisfied: (s) => s.weAreInEnemyCastle && !s.enemyDefendersPresent,
  insistence: (s) => {
    let v = 50;
    if (s.forceRatioBucket === 'ahead') v += 15;
    if (s.forceRatioBucket === 'behind') v -= 15;
    if (s.weHoldRuins) v += 5;
    if (s.wellArmed) v += 5;
    return v;
  },
};

export const GOALS: GoapGoal[] = [secureHome, winByCastle];

/** Pick the goal with highest insistence (ties broken by array order — the
 *  same "first satisfied branch wins" spirit as the old if/else ladder). */
export function selectGoal(state: WorldState, goals: GoapGoal[] = GOALS): GoapGoal {
  let best = goals[0]!;
  let bestScore = -Infinity;
  for (const g of goals) {
    const score = g.insistence(state);
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

// ── Planning (STRIPS-style backward chaining, bounded depth) ─────────────

export interface PlanResult {
  step: GoapAction | null;
  chain: GoapAction[];
}

const MAX_PLAN_DEPTH = 5;

/** Find the next action to take toward `goal` from `state`. Small branching
 *  factor (~8 actions, usually 2-3 satisfy their precondition at once), so a
 *  depth-bounded DFS is enough — no priority queue / open-closed bookkeeping
 *  a general A* would need. Returns the FIRST action of the found chain (the
 *  one to actually execute this turn) plus the full chain for diagnostics. */
export function planStep(
  goal: GoapGoal,
  state: WorldState,
  actions: GoapAction[] = ACTIONS,
): PlanResult {
  if (goal.satisfied(state)) return { step: null, chain: [] };

  // DFS over action sequences, cheapest-first at each branch. Returns the
  // first chain found that satisfies the goal within MAX_PLAN_DEPTH.
  function search(
    s: WorldState,
    depth: number,
    chain: GoapAction[],
  ): GoapAction[] | null {
    if (goal.satisfied(s)) return chain;
    if (depth >= MAX_PLAN_DEPTH) return null;
    const applicable = actions.filter((a) => a.pre(s)).sort((a, b) => a.cost - b.cost);
    for (const a of applicable) {
      // Don't revisit the same action within one chain — every action here is
      // idempotent-ish (its effect flips one fact true), so repeating it can't
      // help and would otherwise loop.
      if (chain.includes(a)) continue;
      const next = a.effect(s);
      const found = search(next, depth + 1, [...chain, a]);
      if (found) return found;
    }
    return null;
  }

  const chain = search(state, 0, []);
  if (!chain || chain.length === 0) return { step: null, chain: [] };
  return { step: chain[0]!, chain };
}

// ── Role assignment ─────────────────────────────────────────────────────
//
// Moved here VERBATIM from ai.ts's applyStrategicOverlay() prelude (the
// farmers/farmerCell/bridgeSquad block and the vanguard/runners block),
// parameterised instead of reading `this.*`. Deliberately not rewritten —
// see the plan file for why: a "cleaner" GOAP formulation risked silently
// undoing historical bug fixes documented in the original Russian comments
// ("только один воин в руинах", "зачем-то подтягивает армию").

export interface Cell {
  row: number;
  col: number;
}

export interface RoleAssignmentUnit {
  id: number;
  row: number;
  col: number;
  type: string;
  maxMoves: number;
}

export interface AssignRolesInput {
  units: RoleAssignmentUnit[];
  /** Ruins cells, grouped by ruins area, in board order (as returned by
   *  getAllRuins() × its width/height — ai.ts passes the flattened list). */
  ruinsCells: Cell[];
  ruinsCentre: Cell | null;
  /** Reference cell (own castle centre) ruins-cell distances are sorted from,
   *  so farmers fill the near edge first. */
  ownCentre: Cell;
  ruinsFarmers: number;
  stage: StrategyStageName;
  goalRow: number;
  goalCol: number;
  /** Path distance, exactly ai.ts's private pathDist — passed in so this
   *  module stays independent of the live board/pathfinding. */
  pathDist: (fromRow: number, fromCol: number, toRow: number, toCol: number) => number;
  /** Exactly ai.ts's private inRuins — whether a cell is inside any ruins
   *  area (not just the pathDist-nearest centre cell). */
  inRuins: (row: number, col: number) => boolean;
}

export interface RoleAssignment {
  farmers: Set<number>;
  farmerCell: Map<number, Cell>;
  bridgeSquad: Set<number>;
  vanguard: Set<number>;
  /** Catapults: siege units with a MIN range (CATAPULT_MIN_RANGE, currently 3
   *  — see game-rules/moves.ts) as well as a max one, so they can't just stack
   *  onto the bridge cell like knights/archers/crossbows do. They hang back
   *  from the bridge/goal at a distance inside their firing band instead. */
  skirmishers: Set<number>;
}

/** Computes farmer/bridgeSquad/vanguard role sets. Verbatim port of the logic
 *  that used to live inline in applyStrategicOverlay() — see file header. */
export function assignRoles(input: AssignRolesInput): RoleAssignment {
  const {
    units,
    ruinsCells,
    ruinsCentre,
    ownCentre,
    ruinsFarmers,
    stage,
    goalRow,
    goalCol,
    pathDist,
    inRuins,
  } = input;

  // ── Post-ruins roles: N farmers stay & level in the ruins; knights+archers
  // hold the bridge ─────────────────────────────────────────────────────────
  const farmers = new Set<number>();
  const bridgeSquad = new Set<number>();
  // Each farmer gets its OWN ruins cell, so 3 of them spread across the area
  // instead of all funnelling onto the single centre (which only fits one —
  // the old "только один воин в руинах" bug).
  const farmerCell = new Map<number, Cell>();
  if (ruinsFarmers > 0 && ruinsCentre) {
    // List the ruins cells, nearest-to-our-side first (so farmers fill the
    // near edge first and don't have to walk through each other).
    const cells = [...ruinsCells].sort(
      (a, b) =>
        pathDist(ownCentre.row, ownCentre.col, a.row, a.col) -
        pathDist(ownCentre.row, ownCentre.col, b.row, b.col),
    );
    // The N units closest to the ruins become farmers.
    const byRuins = [...units].sort(
      (a, b) =>
        pathDist(a.row, a.col, ruinsCentre.row, ruinsCentre.col) -
        pathDist(b.row, b.col, ruinsCentre.row, ruinsCentre.col),
    );
    const chosen = byRuins.slice(0, Math.min(ruinsFarmers, cells.length));
    chosen.forEach((u, i) => {
      farmers.add(u.id);
      farmerCell.set(u.id, cells[i]!); // distinct cell per farmer
    });
    // Melee/mid-range types among the rest hold the bridge cell directly —
    // knight and samurai tank the chokepoint, archer/crossbow shoot from it.
    // Catapults do NOT join this set: they have a minimum firing range (see
    // skirmishers below) and would be useless (or unable to fire at all)
    // sitting on the chokepoint itself.
    for (const u of units) {
      if (farmers.has(u.id)) continue;
      if (u.type === 'knight' || u.type === 'samurai' || u.type === 'archer' || u.type === 'crossbow') {
        bridgeSquad.add(u.id);
      }
    }
  }

  // ── Skirmishers: catapults stand off at their firing band ────────────────
  // A catapult can't hit anything closer than CATAPULT_MIN_RANGE (3 cells),
  // so parking it ON the bridge/goal the way a knight does either wastes it
  // (too close to fire) or exposes it with no support. Marked here purely as
  // a role; ai.ts's targetFor() picks the actual stand-off cell using the
  // real min/max range constants (goap.ts doesn't import game-rules).
  const skirmishers = new Set<number>();
  for (const u of units) {
    if (u.type === 'catapult') skirmishers.add(u.id);
  }

  // ── Runners: ONE or TWO FASTEST units reach the ruins FIRST ──────────────
  // In the opening (sally / take-ruins), the 1–2 units that would ARRIVE
  // soonest sprint to the ruins ahead of the column. "Soonest" = path-distance
  // ÷ move speed, so a cavalry (Moves 3) is picked over a closer-but-slower
  // knight (Moves 2) — the spearhead is genuinely the fastest, not just the
  // nearest. Once someone is IN the ruins, the runner role drops.
  const vanguardStage = stage === 'sally' || stage === 'take-ruins';
  const someoneInRuins = units.some((u) => inRuins(u.row, u.col));
  const vanguard = new Set<number>();
  if (vanguardStage && !someoneInRuins) {
    const eta = (u: RoleAssignmentUnit) =>
      pathDist(u.row, u.col, goalRow, goalCol) / Math.max(1, u.maxMoves);
    // Catapults never spearhead: a siege unit alone at the front with no
    // melee support and a minimum firing range is a free kill, not a runner.
    const candidates = units.filter((u) => u.type !== 'catapult');
    const runners = [...candidates].sort((a, b) => eta(a) - eta(b)).slice(0, 2);
    for (const u of runners) vanguard.add(u.id);
  }

  return { farmers, farmerCell, bridgeSquad, vanguard, skirmishers };
}
