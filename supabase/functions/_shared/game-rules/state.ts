// AUTO-VENDORED from packages/game-rules/src/state.ts — DO NOT EDIT BY HAND.
// Edit the source and re-run scripts/vendor-game-rules.sh.
/**
 * Phase 1.5 S2 — canonical `GameState` for server-side game-rules use.
 *
 * Self-contained, JSON-serialisable, and parameterises every piece of world
 * data that's currently held in `world.ts` module-level mutable state.
 * Server code constructs its own GameState per match and never touches the
 * legacy world.ts getters; the web client continues using the bridge.
 *
 * Phase 4 (T4.18, hard-cut) will collapse the client onto GameState too.
 */
import type {
  BridgeDurability,
  Construction,
  DroppedBackpack,
  GameMode,
  HiddenPickup,
  Player,
  RuinsArea,
  TerrainCell,
  TowerPosition,
} from './types.ts';
import type { SerializedUnit, SerializedWeaponEquip } from './save.ts';

export interface GameState {
  /** World layout — was module-state in world.ts. */
  castleP1Col: number;
  castleP2Col: number;
  towers: readonly TowerPosition[];
  ruins: RuinsArea;
  /** Optional second ruins area (two ruins on the map). Zero-size ⇒ absent. */
  ruins2?: RuinsArea;
  terrain: readonly TerrainCell[];

  /** Towers/bridges a knight is currently building — see BUILD_WORK_TOTAL. */
  constructions: Construction[];
  /** Built bridges' remaining hit points, keyed "row,col" — see BridgeDurability. */
  bridgeDurability: BridgeDurability;

  /** Match flow. */
  currentPlayer: Player;
  turnNumber: number;
  activatedCount: number;
  winner: Player | null;
  mode: GameMode;

  /** Per-player resources. */
  shieldTurns: Record<Player, number>;
  damageBuff: Record<Player, number>;

  /**
   * A weapon crafted (or looted from ruins) this turn that still needs to be
   * equipped to an ally. While non-null the only legal action is `equip-weapon`
   * — mirrors the web client's `pendingWeaponEquip` gate.
   */
  pendingWeaponEquip: SerializedWeaponEquip | null;

  /**
   * A dead unit's whole backpack (weapon parts + weapon + armour), dropped as
   * one object on its death cell. Any of its allies moving onto that cell
   * picks up everything at once — see [[per-unit-backpack]].
   */
  droppedBackpacks: DroppedBackpack[];

  /**
   * Hidden artifacts/weapons/armour buried across the board at setup. Invisible
   * to players, never respawn, and claimed by the first unit that steps on the
   * cell. Scattered once by `scatterHiddenPickups`.
   */
  hiddenPickups: HiddenPickup[];

  /** Unit roster, in SerializedUnit shape so this state is wire-clean. */
  units: SerializedUnit[];
  nextUnitId: number;

  /** Determinism — Phase 1.5 S3 hooks the seeded RNG here. */
  rngSeed: number;
  rngCursor: number;

  /** Match-record audit field. Bumps whenever rules logic changes. */
  rulesVersion: number;
}

/**
 * GameState fields owned by the match server only. Save-layer metadata
 * (story progress, map theme, faction selection) lives on the snapshot
 * wrapper instead — the server doesn't need that.
 */

/** Current rules version. Bump when applyAction semantics change. */
export const RULES_VERSION = 1;

/** Max distinct units a player may activate (act with) in a single turn.
 * Mirrors the web client's `maxActivatedPerTurn`. */
export const MAX_ACTIVATIONS_PER_TURN = 3;
