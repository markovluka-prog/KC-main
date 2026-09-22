/**
 * `candidateActions` — a branching-factor filter on top of `generateActionsForUnit`.
 *
 * Plan step 2: measured fan-out (see git history of this file's introducing
 * commit / actions.test.ts) shows most unit types stay at a sane 4-12 actions
 * per turn, but ranged units surrounded by many enemies blow up fast — a
 * catapult with 6 enemies in its 3-6 range band alone produces enemies× attack
 * variants, and an archer in the open can walk up to 3 cells in 4 directions.
 * Measured worst case in this codebase: a catapult with ~70 enemies in range
 * band produced 76 actions in one call. A beam search that expands every
 * child at every depth cannot afford that per unit per node — K distinct
 * units × that fan-out compounds multiplicatively per beam step.
 *
 * This module doesn't change what's *legal* (generateActionsForUnit is still
 * the source of truth — every action returned here is one it produced) — it
 * trims to the actions actually worth searching:
 *   - all move actions are kept (already small: ≤12, one per reachable cell)
 *   - all attacks that are LETHAL are kept (never prune a kill)
 *   - non-lethal attacks are capped to the top N by immediate damage dealt
 *   - spell/craft/craft-armor/search-ruins/castle-heal are kept as-is (at
 *     most a handful of these exist per unit: 3 spells, 2 weapons, 2 armors)
 */
import { type ServerAction } from './apply.js';
import { type Rng } from './rng.js';
import type { GameState } from './state.js';
/** Max non-lethal attack variants kept per unit per call. Lethal attacks are never pruned. */
export declare const MAX_NON_LETHAL_ATTACKS = 4;
/**
 * Every action for `unitId` worth expanding in a search — a filtered view of
 * `generateActionsForUnit` that keeps branching factor bounded without ever
 * discarding a lethal attack.
 *
 * `rng` defaults to `nondetRng()` for callers outside a search (e.g. ad hoc
 * exploration) — but any caller that cares about reproducibility (planTurn,
 * greedyTurn, the arena) MUST pass its own seeded Rng, or the scratch
 * `applyAction` calls this makes internally (never observable in the
 * returned actions, but still real RNG draws) will desync from a rerun with
 * the same seed. See beam.ts's `searchPlans` for the pattern.
 */
export declare function candidateActions(state: GameState, unitId: number, rng?: Rng): ServerAction[];
/** `candidateActions` for every unit `player` can still act with this turn. */
export declare function candidateActionsForPlayer(state: GameState, player: 1 | 2, rng?: Rng): ServerAction[];
//# sourceMappingURL=candidates.d.ts.map