/**
 * Feature encoding for the learned policy/value network (see nn-eval.ts).
 *
 * Turns a LightState (ai.ts's search-internal position representation) into a
 * fixed-size numeric tensor from ONE player's perspective ("me" vs "opp"), so
 * the same encoder run twice on a mirrored position produces the same
 * features — the network never has to learn "player 1 vs player 2" as a
 * concept, only "me vs opponent". That symmetry is what let the old tabular
 * Q-brain's replacement (a hand-written eval) generalise across the board;
 * a learned net gets the same property for free here instead of having to
 * discover it from scratch across millions of self-play games.
 *
 * Two output tensors:
 *  - `spatial`: Float32Array[ROWS*COLS*PLANES], one plane per (side, unit-type)
 *    combination plus a few board-geometry planes (castle zones, towers,
 *    ruins). This is what a small conv trunk consumes.
 *  - `scalar`: Float32Array[SCALAR_FEATURES], global features a conv can't see
 *    easily (activations left, inventory counts, buff timers, unit counts).
 *
 * IMPORTANT: this module must stay dependency-free (no DOM, no game class) so
 * it can run unmodified in three places: the browser (live inference), the
 * Node self-play generator (scripts/nn-selfplay.ts), and — mirrored in
 * Python by scripts/nn_features.py — the offline trainer. If you change the
 * layout here, bump FEATURE_VERSION and update the Python mirror, or a
 * trained net will silently misread positions exported before the change.
 */
import { getCastleP1Col, getCastleP2Col, getTowers, getAllRuins, ROWS, COLS } from '@kc/game-rules';
import type { Player, UnitTypeKey } from '@kc/game-rules';

/** Bump whenever the encoding below changes shape or meaning. */
export const FEATURE_VERSION = 1;

// Unit types that appear in LightState. 'mage' is included for forward
// compatibility even though the current search doesn't model mage units in
// LightState yet — an absent type just stays all-zero.
export const UNIT_TYPE_ORDER: readonly UnitTypeKey[] = [
  'knight',
  'cavalry',
  'archer',
  'crossbow',
  'catapult',
  'samurai',
  'mage',
];
const TYPE_INDEX: Record<string, number> = Object.fromEntries(
  UNIT_TYPE_ORDER.map((t, i) => [t, i]),
);

// ── Spatial planes ────────────────────────────────────────────────────────
// Per side: one presence plane per unit type + 3 stat planes (hp/armor/damage,
// normalised, painted only on the occupied cell). Plus shared geometry planes.
const STAT_PLANES_PER_SIDE = 3; // hp, armor, damage
const PLANES_PER_SIDE = UNIT_TYPE_ORDER.length + STAT_PLANES_PER_SIDE;
const GEOMETRY_PLANES = 4; // my-castle, opp-castle, tower, ruins
export const NUM_PLANES = PLANES_PER_SIDE * 2 + GEOMETRY_PLANES;
export const SPATIAL_SIZE = ROWS * COLS * NUM_PLANES;

// ── Scalar (non-spatial) features ────────────────────────────────────────
// [activationsLeft/3, myCount/10, oppCount/10, myHpTotal/40, oppHpTotal/40,
//  shieldTurnsMe/5, shieldTurnsOpp/5, damageBuffMe/5, damageBuffOpp/5,
//  ...5 inventory part counts /10]
export const SCALAR_FEATURES = 9 + 5;

const PART_NAMES = ['Металл', 'Амулет', 'Рубин', 'Дерево', 'Стрелы'] as const;

/** Minimal shape both LightState and HarnessState satisfy. */
export interface EncodableUnit {
  player: Player;
  type: string;
  row: number;
  col: number;
  hp: number;
  maxHp: number;
  armor: number;
  maxArmor: number;
  damage: number;
}

export interface EncodableState {
  units: readonly EncodableUnit[];
  shieldTurns: Record<Player, number>;
  damageBuff: Record<Player, number>;
  activationsLeft: number;
  inventory: Partial<Record<string, number>>;
}

/** Extra context the encoder needs but LightState/HarnessState don't carry:
 *  which board row each player's castle sits on. Mirrors AIPlayer.castleZone
 *  in ai.ts — player 1's castle is row 16 when player1Bottom, else row 0 (and
 *  vice-versa for player 2). Callers running inside AIPlayer already have
 *  this.game.player1Bottom; the self-play harness fixes it per game. */
export interface BoardOrientation {
  player1Bottom: boolean;
}

export interface EncodedPosition {
  spatial: Float32Array; // [ROWS, COLS, NUM_PLANES] flattened, row-major, channel-last
  scalar: Float32Array;
}

function planeIndex(row: number, col: number, plane: number): number {
  return (row * COLS + col) * NUM_PLANES + plane;
}

/**
 * Encode `state` from `perspective`'s point of view. Rows are NOT flipped —
 * the search already works in canonical board coordinates (see castleZone in
 * ai.ts), so "me"/"opp" only swaps which side's units land in which plane
 * block; geometry (castle zones, towers, ruins) is painted as-is.
 */
export function encodeState(
  state: EncodableState,
  perspective: Player,
  orientation: BoardOrientation,
): EncodedPosition {
  const spatial = new Float32Array(SPATIAL_SIZE);
  const opp: Player = perspective === 1 ? 2 : 1;

  let myCount = 0;
  let oppCount = 0;
  let myHpTotal = 0;
  let oppHpTotal = 0;

  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (u.row < 0 || u.row >= ROWS || u.col < 0 || u.col >= COLS) continue;
    const mine = u.player === perspective;
    const sideBase = mine ? 0 : PLANES_PER_SIDE;
    const typeIdx = TYPE_INDEX[u.type] ?? TYPE_INDEX.archer!;
    const presencePlane = sideBase + typeIdx;
    spatial[planeIndex(u.row, u.col, presencePlane)] = 1;

    const hpPlane = sideBase + UNIT_TYPE_ORDER.length + 0;
    const armorPlane = sideBase + UNIT_TYPE_ORDER.length + 1;
    const dmgPlane = sideBase + UNIT_TYPE_ORDER.length + 2;
    spatial[planeIndex(u.row, u.col, hpPlane)] = clamp01(u.hp / Math.max(1, u.maxHp || u.hp));
    spatial[planeIndex(u.row, u.col, armorPlane)] = clamp01(u.armor / Math.max(1, u.maxArmor || u.armor || 1));
    spatial[planeIndex(u.row, u.col, dmgPlane)] = clamp01(u.damage / 10);

    if (mine) {
      myCount += 1;
      myHpTotal += u.hp;
    } else {
      oppCount += 1;
      oppHpTotal += u.hp;
    }
  }

  // Geometry planes: constant per match, but cheap enough to paint per call
  // and simplest to keep correct (no separate cache-invalidation path).
  const geomBase = PLANES_PER_SIDE * 2;
  paintCastleZone(spatial, geomBase + 0, perspective, orientation.player1Bottom);
  paintCastleZone(spatial, geomBase + 1, opp, orientation.player1Bottom);
  for (const t of getTowers()) {
    if (insideGrid(t.row, t.col)) spatial[planeIndex(t.row, t.col, geomBase + 2)] = 1;
  }
  for (const area of getAllRuins()) {
    for (let r = area.top; r < area.top + area.height; r += 1) {
      for (let c = area.left; c < area.left + area.width; c += 1) {
        if (insideGrid(r, c)) spatial[planeIndex(r, c, geomBase + 3)] = 1;
      }
    }
  }

  const scalar = new Float32Array(SCALAR_FEATURES);
  scalar[0] = clamp01(state.activationsLeft / 3);
  scalar[1] = clamp01(myCount / 10);
  scalar[2] = clamp01(oppCount / 10);
  scalar[3] = clamp01(myHpTotal / 40);
  scalar[4] = clamp01(oppHpTotal / 40);
  scalar[5] = clamp01((state.shieldTurns[perspective] ?? 0) / 5);
  scalar[6] = clamp01((state.shieldTurns[opp] ?? 0) / 5);
  scalar[7] = clamp01((state.damageBuff[perspective] ?? 0) / 5);
  scalar[8] = clamp01((state.damageBuff[opp] ?? 0) / 5);
  PART_NAMES.forEach((name, i) => {
    scalar[9 + i] = clamp01((state.inventory[name] ?? 0) / 10);
  });

  return { spatial, scalar };
}

function insideGrid(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Castle zone (4x4) for `owner`, mirroring AIPlayer.castleZone in ai.ts. */
function paintCastleZone(
  spatial: Float32Array,
  plane: number,
  owner: Player,
  player1Bottom: boolean,
): void {
  const col = owner === 1 ? getCastleP1Col() : getCastleP2Col();
  const row = owner === 1 ? (player1Bottom ? 16 : 0) : player1Bottom ? 0 : 16;
  for (let r = row; r < row + 4; r += 1) {
    for (let c = col; c < col + 4; c += 1) {
      if (insideGrid(r, c)) spatial[planeIndex(r, c, plane)] = 1;
    }
  }
}
