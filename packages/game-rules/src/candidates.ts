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

import { applyAction, type ServerAction } from './apply.js';
import { nondetRng, type Rng } from './rng.js';
import { generateActionsForUnit } from './actions.js';
import type { GameState } from './state.js';

/** Max non-lethal attack variants kept per unit per call. Lethal attacks are never pruned. */
export const MAX_NON_LETHAL_ATTACKS = 4;

interface ScoredAttack {
  action: ServerAction & { kind: 'attack' };
  damage: number;
  lethal: boolean;
}

/**
 * Replay `attack` against `rng` to see what it actually does — reuses
 * applyAction's real damage formula (armor absorption, tower penalty, buffs,
 * shields, archer min-1) instead of re-deriving it, so the filter can never
 * disagree with what the action actually resolves to.
 *
 * `attack` never itself consumes RNG (the damage formula is deterministic —
 * only `search-ruins`/`draw-artifact` roll loot), so which Rng instance is
 * passed here has no effect on the score. It's threaded through anyway so
 * every applyAction call in this module shares the caller's single Rng
 * instance rather than each minting its own — keeping the invariant simple
 * ("one Rng per search, no ad hoc nondetRng() calls scattered around") is
 * worth more than the (currently zero) cases where it would matter.
 */
function scoreAttack(state: GameState, action: ServerAction & { kind: 'attack' }, rng: Rng): ScoredAttack | null {
  const target = state.units.find(
    (u) => u.row === action.targetRow && u.col === action.targetCol && u.hp > 0,
  );
  if (!target) return null;
  const result = applyAction(state, action, rng);
  if (!result.ok) return null;
  const after = result.value.units.find((u) => u.id === target.id);
  const lethal = !after || after.hp <= 0;
  const hpBefore = target.hp;
  const hpAfter = after ? after.hp : 0;
  const armorAbsorbed = Math.max(0, target.armor - (after ? after.armor : 0));
  const damage = hpBefore - hpAfter + armorAbsorbed;
  return { action, damage, lethal };
}

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
export function candidateActions(state: GameState, unitId: number, rng: Rng = nondetRng()): ServerAction[] {
  const all = generateActionsForUnit(state, unitId);
  const attacks = all.filter((a): a is ServerAction & { kind: 'attack' } => a.kind === 'attack');
  const rest = all.filter((a) => a.kind !== 'attack');

  if (attacks.length <= MAX_NON_LETHAL_ATTACKS) return all;

  const scored = attacks
    .map((a) => scoreAttack(state, a, rng))
    .filter((s): s is ScoredAttack => s !== null);

  const lethal = scored.filter((s) => s.lethal).map((s) => s.action);
  const nonLethal = scored
    .filter((s) => !s.lethal)
    .sort((a, b) => b.damage - a.damage)
    .slice(0, MAX_NON_LETHAL_ATTACKS)
    .map((s) => s.action);

  return [...rest, ...lethal, ...nonLethal];
}

/** `candidateActions` for every unit `player` can still act with this turn. */
export function candidateActionsForPlayer(state: GameState, player: 1 | 2, rng: Rng = nondetRng()): ServerAction[] {
  const out: ServerAction[] = [];
  for (const u of state.units) {
    if (u.player !== player || u.hp <= 0 || u.done) continue;
    out.push(...candidateActions(state, u.id, rng));
  }
  return out;
}
