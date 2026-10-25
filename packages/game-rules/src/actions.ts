/**
 * Turn `GameState` into a `BoardLike` view, and enumerate every legal
 * `ServerAction` a unit could take right now — move, attack, and the
 * non-generated actions (`spell`, `craft`, `craft-armor`, `search-ruins`,
 * `castle-heal`) that previously only existed as `applyAction` dispatch
 * targets with no enumerable generator.
 *
 * This is the missing piece a state-space search (beam search, minimax, MCTS)
 * needs to walk `GameState` directly via `applyAction`, instead of every
 * caller hand-rolling its own action list. `resign`/`end-turn` are
 * intentionally excluded (turn-level, not per-unit).
 *
 * `equip-weapon` IS generated (see the pendingWeaponEquip gate below) —
 * earlier versions of this generator omitted it entirely on the theory that
 * it's "forced, handled by the caller first". That was wrong: `applyAction`
 * rejects every OTHER action kind with a `weapon-pending` error the moment
 * `state.pendingWeaponEquip` is set (see apply.ts's global gate), so a
 * search that doesn't offer `equip-weapon` there sees every unit go
 * completely actionless — discovered via a long beam-vs-greedy arena game
 * silently stalling turn after turn once a hidden pickup got claimed.
 */

import { turnCost } from './facing.js';
import { canEquipGear, type ServerAction } from './apply.js';
import { generateAllActions } from './moves.js';
import { inCastleZone, castleColFor, castleRowFor } from './apply.js';
import {
  ARMORS,
  BUILD_COST_PER_TURN,
  MAGE_ATTACK_ENERGY_PER_CELL,
  MAGE_ATTACK_ENERGY_PER_HP,
  MAGE_BURN_BRIDGE_ENERGY_PER_CELL,
  MAGE_HEAL_ENERGY_PER_CELL,
  MAGE_HEAL_ENERGY_PER_HP,
  WEAPONS,
} from './constants.js';
import { insideBoard } from './board.js';
import { MAX_ACTIVATIONS_PER_TURN, type GameState } from './state.js';
import type { SerializedUnit } from './save.js';
import type { Backpack, PartName, Player } from './types.js';

const ORTHO_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export { boardFromState } from './board-state.js';
import { boardFromState, boardFromStateScratch, toUnitState } from './board-state.js';

/** True if `backpack` holds at least `recipe`'s counts of every part — crafting
 * always spends the crafting unit's OWN backpack, not a shared per-player pool.
 * Recipes are pre-split into [part, n] pairs once (this runs per unit per
 * recipe on every search node). */
const RECIPE_ENTRIES = new WeakMap<object, Array<[PartName, number]>>();
function canAffordFromBackpack(backpack: Backpack, recipe: Partial<Record<PartName, number>>): boolean {
  let entries = RECIPE_ENTRIES.get(recipe);
  if (!entries) {
    entries = Object.entries(recipe).map(([p, n]) => [p as PartName, n ?? 0]);
    RECIPE_ENTRIES.set(recipe, entries);
  }
  for (const [part, n] of entries) {
    if ((backpack[part] ?? 0) < n) return false;
  }
  return true;
}

/**
 * Every legal action `unit` could take this instant, spanning move, attack,
 * and the economy/support actions (craft/craft-armor/castle-heal/build/mage). Skips anything the unit can't afford/reach so callers don't
 * have to re-derive eligibility — every returned action is expected to
 * succeed if passed straight to `applyAction`.
 *
 * NOTE: `spell`/`craft`/`craft-armor` each cost exactly 1 move and don't move
 * the unit, so they're only offered when `movesLeft >= 1` — same gate
 * `applyAction` itself enforces.
 */
export function generateActionsForUnit(
  state: GameState,
  unitId: number,
  sharedBoard?: ReturnType<typeof boardFromState>,
): ServerAction[] {
  const unit = state.units.find((u) => u.id === unitId && u.hp > 0);
  if (!unit) return [];
  if (unit.player !== state.currentPlayer) return [];

  // A crafted/looted/found item blocks EVERY other action until equipped —
  // applyAction's global gate rejects anything but `equip-weapon` while
  // pendingWeaponEquip is set (see this function's doc comment). Note
  // applyEquipWeapon itself doesn't check unit.done/movesLeft, so this must
  // be tested before the done/movesLeft early-return below, or an already-
  // done unit that's the only one able to wear the item would wrongly report
  // zero actions and stall the whole turn.
  if (state.pendingWeaponEquip) {
    return canEquipGear(state.pendingWeaponEquip, unit, state.currentPlayer)
      ? [{ kind: 'equip-weapon', unitId }]
      : [];
  }

  if (unit.done || unit.movesLeft <= 0) return [];
  // The turn's activation cap: once MAX_ACTIVATIONS_PER_TURN distinct units
  // have acted, a fresh unit can't — applyAction rejects it with
  // 'activation-limit', so offering it here only wasted search effort and
  // produced plans the reducer refuses.
  if (!unit.activated && state.activatedCount >= MAX_ACTIVATIONS_PER_TURN) return [];

  const board = sharedBoard ?? boardFromState(state);
  const actions: ServerAction[] = [];

  for (const a of generateAllActions(board, toUnitState(unit))) {
    if (a.kind === 'move') {
      actions.push({ kind: 'move', unitId, row: a.row, col: a.col, cost: a.cost });
    } else {
      actions.push({
        kind: 'attack',
        unitId,
        mode: a.mode,
        cost: a.cost,
        targetRow: a.targetRow,
        targetCol: a.targetCol,
        landingRow: a.landingRow,
        landingCol: a.landingCol,
        targets: a.targets,
      });
    }
  }

  if (unit.movesLeft >= 1) {
    // Crafting always spends the crafting unit's OWN backpack — any unit can
    // craft, not just a caster on a tower (the old spell system is gone).
    WEAPONS.forEach((weapon, index) => {
      if (canAffordFromBackpack(unit.backpack, weapon.recipe)) {
        actions.push({ kind: 'craft', unitId, index });
      }
    });
    ARMORS.forEach((armor, index) => {
      if (canAffordFromBackpack(unit.backpack, armor.recipe)) {
        actions.push({ kind: 'craft-armor', unitId, index });
      }
    });

    // No 'search-ruins': ruins hold nothing any more — loot is buried board-
    // wide and claimed by walking onto it (the web client's Board.inRuins is
    // false everywhere). Offering it let the search plan a step the game
    // refuses.

    const ownRow = castleRowFor(unit.player);
    const ownCol = castleColFor(state, unit.player);
    if (inCastleZone(unit, ownRow, ownCol) && (unit.hp < unit.maxHp || unit.armor < unit.maxArmor)) {
      actions.push({ kind: 'castle-heal', unitId });
    }

    if (unit.type === 'mage') {
      actions.push(...generateMageActions(state, unit));
    }
  }

  // Building: a knight with its FULL movesLeft still available (it commits
  // its whole turn, all at once — see applyBuild) can start or continue a
  // tower/bridge on any orthogonally adjacent cell.
  if (unit.type === 'knight' && unit.movesLeft === BUILD_COST_PER_TURN) {
    const constructions = state.constructions ?? [];
    const alive = state.units.filter((u) => u.hp > 0);
    for (const [dr, dc] of ORTHO_DIRS) {
      const row = unit.row + dr;
      const col = unit.col + dc;
      if (!insideBoard(row, col)) continue;
      const site = constructions.find((c) => c.row === row && c.col === col);
      if (site) {
        actions.push({ kind: site.kind === 'tower' ? 'build-tower' : 'build-bridge', unitId, row, col });
        continue;
      }
      const occupied = alive.some((u) => u.row === row && u.col === col);
      const isRiver = state.terrain.some((t) => t.row === row && t.col === col && t.type === 'river');
      const isBlocked = state.terrain.some(
        (t) =>
          t.row === row &&
          t.col === col &&
          (t.type === 'mountain' || t.type === 'rock' || t.type === 'river' || t.type === 'bridge'),
      );
      const hasTower = state.towers.some((t) => t.row === row && t.col === col);
      if (isRiver && !occupied) {
        actions.push({ kind: 'build-bridge', unitId, row, col });
      } else if (!isBlocked && !occupied && !hasTower) {
        actions.push({ kind: 'build-tower', unitId, row, col });
      }
    }
  }

  return actions;
}

/**
 * Every mage-* ability `unit` (a mage with a move left) can currently afford
 * out of its own energy pool — attack/drain any target in range, ward its own
 * side, burn any bridge it can reach, and heal any hurt ally (including
 * itself) it can reach. Mirrors the energy formulas in apply.ts's
 * applyMage*() functions exactly, so every action offered here is guaranteed
 * to succeed if passed straight to `applyAction`.
 */
function generateMageActions(state: GameState, mage: SerializedUnit): ServerAction[] {
  const out: ServerAction[] = [];
  const energy = mage.energy ?? 0;
  const alive = state.units.filter((u) => u.hp > 0);

  for (const other of alive) {
    const chebyshev = Math.max(Math.abs(other.row - mage.row), Math.abs(other.col - mage.col));

    if (other.player !== mage.player) {
      // mage-attack: the player picks the damage amount now (see
      // [[kc-mage-ward-mechanic]]) — cost = damage*1 + distance*PER_CELL.
      // Offer the max damage this mage can afford at this distance (most
      // efficient use of energy for a search), and a minimal 1-damage jab
      // for cheap chip damage/energy conservation, when they differ.
      const distCost = chebyshev * MAGE_ATTACK_ENERGY_PER_CELL;
      const maxDamage = Math.floor((energy - distCost) / MAGE_ATTACK_ENERGY_PER_HP);
      if (maxDamage >= 1) {
        out.push({ kind: 'mage-attack', unitId: mage.id, targetRow: other.row, targetCol: other.col, damage: maxDamage });
        if (maxDamage > 1) {
          out.push({ kind: 'mage-attack', unitId: mage.id, targetRow: other.row, targetCol: other.col, damage: 1 });
        }
      }
      // mage-drain: only an adjacent enemy above 1 hp, not warded by a
      // DIFFERENT mage (see [[kc-mage-ward-mechanic]]).
      if (chebyshev <= 1 && other.hp > 1 && (!other.wardedBy || other.wardedBy === mage.id)) {
        out.push({ kind: 'mage-drain', unitId: mage.id, targetUnitId: other.id });
      }
    } else {
      // mage-drain also works on an adjacent ally (self-service energy top-up).
      if (chebyshev === 1 && other.hp > 1) {
        out.push({ kind: 'mage-drain', unitId: mage.id, targetUnitId: other.id });
      }
      // mage-heal: any hurt ally (including itself) within energy range.
      if (other.hp < other.maxHp) {
        const missing = other.maxHp - other.hp;
        const healCost = missing * MAGE_HEAL_ENERGY_PER_HP + chebyshev * MAGE_HEAL_ENERGY_PER_CELL;
        if (energy >= healCost) {
          out.push({ kind: 'mage-heal', unitId: mage.id, targetUnitId: other.id });
        }
      }
    }
  }

  // mage-ward: free to apply (no upfront energy cost — see applyMageWard),
  // toggled per living ally. Offered as one action per ally so a search can
  // pick any single unit to (un)ward for 1 move, matching how the client
  // lets the player build up a multi-select batch one click at a time.
  // Wards are meant to stay up: cast on every ally that has none (a unit
  // already shielded by ANOTHER living mage is left alone), and lift one only
  // in the extreme case — this mage nearly out of energy, so the ward could no
  // longer pay for a hit (the mage would die instead).
  for (const ally of alive) {
    if (ally.player !== mage.player) continue;
    const holder = ally.wardedBy ? alive.find((u) => u.id === ally.wardedBy && u.type === 'mage') : undefined;
    if (!holder) {
      out.push({ kind: 'mage-ward', unitId: mage.id, toggleUnitIds: [ally.id] });
    } else if (holder.id === mage.id && energy < 2) {
      out.push({ kind: 'mage-ward', unitId: mage.id, toggleUnitIds: [ally.id] });
    }
  }

  // mage-burn-bridge: any bridge the mage can afford to reach.
  for (const t of state.terrain) {
    if (t.type !== 'bridge') continue;
    if (state.units.some((u) => u.hp > 0 && u.row === t.row && u.col === t.col)) continue; // occupied
    const chebyshev = Math.max(Math.abs(t.row - mage.row), Math.abs(t.col - mage.col));
    const cost = chebyshev * MAGE_BURN_BRIDGE_ENERGY_PER_CELL;
    if (energy >= cost) {
      out.push({ kind: 'mage-burn-bridge', unitId: mage.id, row: t.row, col: t.col });
    }
  }

  // Aiming into the mage's own back half costs +1 move to turn round
  // (facing.ts) — drop what it can't afford with the moves it has left.
  const at = (x: ServerAction): { row: number; col: number } | null => {
    if (x.kind === 'mage-attack') return { row: x.targetRow, col: x.targetCol };
    if (x.kind === 'mage-burn-bridge') return { row: x.row, col: x.col };
    if (x.kind === 'mage-drain') return alive.find((u) => u.id === x.targetUnitId) ?? null;
    return null;
  };
  return out.filter((x) => {
    const c = at(x);
    return !c || mage.movesLeft >= 1 + turnCost(mage, c.row, c.col);
  });
}

/** Every unit belonging to `player` that can still act this turn (not done, alive). */
export function actableUnitIds(state: GameState, player: Player): number[] {
  return state.units.filter((u) => u.player === player && u.hp > 0 && !u.done).map((u) => u.id);
}

/**
 * All legal actions for every unit `player` still owns an activation slot
 * or in-progress action for. Equivalent to flat-mapping
 * `generateActionsForUnit` over `actableUnitIds`, provided as one call for
 * search code that just wants "everything I could do right now".
 */
export function generateActionsForPlayer(state: GameState, player: Player): ServerAction[] {
  const out: ServerAction[] = [];
  // One board for every unit's generator, built in reused buffers: the board
  // is finished with before this function returns.
  const board = boardFromStateScratch(state);
  for (const id of actableUnitIds(state, player)) {
    out.push(...generateActionsForUnit(state, id, board));
  }
  return out;
}
