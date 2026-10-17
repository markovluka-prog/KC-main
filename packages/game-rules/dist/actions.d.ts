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
import { type ServerAction } from './apply.js';
import { type GameState } from './state.js';
import type { Player } from './types.js';
export { boardFromState } from './board-state.js';
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
export declare function generateActionsForUnit(state: GameState, unitId: number): ServerAction[];
/** Every unit belonging to `player` that can still act this turn (not done, alive). */
export declare function actableUnitIds(state: GameState, player: Player): number[];
/**
 * All legal actions for every unit `player` still owns an activation slot
 * or in-progress action for. Equivalent to flat-mapping
 * `generateActionsForUnit` over `actableUnitIds`, provided as one call for
 * search code that just wants "everything I could do right now".
 */
export declare function generateActionsForPlayer(state: GameState, player: Player): ServerAction[];
//# sourceMappingURL=actions.d.ts.map