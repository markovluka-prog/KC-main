/**
 * Bridge between the live `AIGameAPI`/`Board` (packages/web) and
 * `@kc/game-rules`'s pure `GameState`/`planTurn` — plan step 6.
 *
 * `@kc/game-rules` is server-authoritative and assumes a CANONICAL
 * orientation: player 1's castle is always rows 0-3, player 2's is always
 * rows (ROWS-4)..(ROWS-1). The live single-player game does not honour that:
 * `Board.player1Bottom` physically flips every unit's row at placement time
 * (see Board.ts's `initUnits`) purely so the human's units render at the
 * bottom of the screen. `evaluate()`/`maybeFinishMatch()` in game-rules have
 * no notion of that flip — they hardcode player 1 = top exactly like the
 * server does, because the server has no rendering concept to flip for.
 *
 * So this module normalises the live board into canonical orientation before
 * handing it to `planTurn`, and denormalises the resulting plan's coordinates
 * back to the live board's actual orientation before it's executed. Every
 * OTHER field (columns, terrain, towers, ruins, inventory) is untouched by
 * the flip — only ROW coordinates and which player's castle sits at row 0
 * depend on it.
 */

import {
  createInitialState,
  planTurnFor,
  flipFacing,
  ROWS,
  getCastleP1Col,
  getCastleP2Col,
  getAllRuins,
  getBridgeDurability,
  getConstructions,
  getTerrain,
  getTowers,
  type AIWeights,
  type BeamDifficultyConfig,
  type GameState,
  type Player,
  type ServerAction,
} from '@kc/game-rules';
import type { SerializedUnit } from '@kc/game-rules';
import type { AIAction, AIGameAPI } from './ai.js';
import type { Unit } from './Unit.js';

/** Flip a physical row into canonical (player-1-top) orientation, or back — the
 * transform is its own inverse, so one function does both directions. */
function flipRow(row: number, player1Bottom: boolean): number {
  return player1Bottom ? ROWS - 1 - row : row;
}

function toSerializedUnit(u: Unit, player1Bottom: boolean): SerializedUnit {
  return {
    id: u.id,
    player: u.player,
    type: u.type,
    row: flipRow(u.row, player1Bottom),
    col: u.col,
    maxHp: u.maxHp,
    hp: u.hp,
    startArmor: u.startArmor,
    armor: u.armor,
    maxArmor: u.maxArmor,
    damage: u.damage,
    maxMoves: u.maxMoves,
    movesLeft: u.movesLeft,
    done: u.done,
    activated: (u as Unit & { activated?: boolean }).activated === true,
    visualRow: null,
    visualCol: null,
    dying: false,
    deathProgress: 0,
    weapon: u.weapon ? { name: u.weapon.name, icon: u.weapon.icon, amount: u.weapon.amount } : null,
    armorGear: u.armorGear
      ? { name: u.armorGear.name, icon: u.armorGear.icon, amount: u.armorGear.amount }
      : null,
    backpack: { ...u.backpack },
    // Wards and mage energy change what a hit actually does (a warded unit
    // takes 0, its mage pays or dies) — without them the search planned
    // "kills" on shielded units that the real game then absorbed.
    wardedBy: u.wardedBy ?? null,
    // Facing is in live rows too: flip up/down with the board.
    facing: player1Bottom ? flipFacing(u.facing) : u.facing,
    ...(u.type === 'mage'
      ? { energy: u.energy, maxEnergy: u.maxEnergy, warding: [...(u.warding ?? [])] }
      : {}),
  };
}

/**
 * Snapshot the live game into a canonical-orientation `GameState`. Terrain,
 * towers and ruins are already in absolute board coordinates unaffected by
 * player1Bottom (only which player's castle sits at row 0 depends on it), so
 * only unit rows and the castleP1Col/castleP2Col mapping need adjusting.
 *
 * `rngSeed`/`rngCursor` are set to fixed placeholders: the beam search only
 * ever calls actions that don't consume the RNG (moves/attacks/spells/craft
 * are all deterministic; search-ruins/draw-artifact DO roll loot, but
 * candidateActions still includes them as legal — their outcome doesn't
 * affect what action gets chosen by evaluate(), which prices "loot is
 * available" not "which specific item"). If reintroducing seeded loot
 * determinism into the bridge later matters, thread the live game's actual
 * seed/cursor through AIGameAPI instead of hardcoding this.
 */
export function snapshotGameState(game: AIGameAPI): GameState {
  const player1Bottom = game.player1Bottom;
  const units: SerializedUnit[] = game.board.units
    .filter((u) => u.alive())
    .map((u) => toSerializedUnit(u, player1Bottom));

  const ruinsAreas = getAllRuins();
  const terrain = getTerrain().map((t) => ({
    ...t,
    row: flipRow(t.row, player1Bottom),
  }));
  const towers = getTowers().map((t) => ({ ...t, row: flipRow(t.row, player1Bottom) }));
  // A RuinsArea covers physical rows [top, top+height). Flipping row r maps
  // it to ROWS-1-r, so the rectangle's new top-left row is the flip of its
  // OLD BOTTOM row (top+height-1), not its old top row — flipping just `top`
  // would place the rectangle one row off and pointing the wrong way.
  const flipRuinsArea = (area: (typeof ruinsAreas)[number]) => ({
    ...area,
    top: flipRow(area.top + area.height - 1, player1Bottom),
  });
  // Ruins are scenery only now (Board.inRuins is false everywhere), so the
  // search must not see a searchable rectangle there.
  void ruinsAreas;
  void flipRuinsArea;
  const ruins = { top: 0, left: 0, width: 0, height: 0 };
  const ruins2 = { top: 0, left: 0, width: 0, height: 0 };

  // Unfinished build sites are impassable and bridges have hit points — the
  // search has to see both or it plans moves through sites that will fail.
  const constructions = getConstructions().map((c) => ({ ...c, row: flipRow(c.row, player1Bottom) }));
  const bridgeDurability: Record<string, number> = {};
  for (const [key, hp] of Object.entries(getBridgeDurability())) {
    const [r, c] = key.split(',').map(Number);
    bridgeDurability[`${flipRow(r!, player1Bottom)},${c}`] = hp;
  }

  const state = createInitialState({
    mode: 'ai',
    seed: 1,
    units,
    constructions,
    bridgeDurability,
    // Flipping rows doesn't change which castle belongs to whom: P1's castle
    // stays at castleP1Col, it just moves to the top rows like P1's units.
    castleP1Col: getCastleP1Col(),
    castleP2Col: getCastleP2Col(),
    towers,
    ruins,
    ruins2,
    terrain,
  });
  state.currentPlayer = game.currentPlayer;
  state.activatedCount = game.activatedCount ?? 0;
  // Per-unit backpacks are already carried by `units` above — there's no
  // shared per-player inventory to copy across any more.
  state.shieldTurns = { ...game.shieldTurns };
  state.damageBuff = { ...game.damageBuff };
  return state;
}

/** Convert one `ServerAction` (canonical orientation) into the `{unitId, AIAction}`
 * shape `AIPlayer.executeAction` consumes, denormalising rows back to the
 * live board's actual orientation. */
export function toPlanEntry(
  action: ServerAction,
  player1Bottom: boolean,
): { unitId: number; action: AIAction } | null {
  const flip = (row: number): number => flipRow(row, player1Bottom);
  switch (action.kind) {
    case 'move':
      return {
        unitId: action.unitId,
        action: { type: 'move', row: flip(action.row), col: action.col, cost: action.cost, score: 0 },
      };
    case 'attack':
      // executeAction() (ai.ts) only ever reads targetRow/targetCol (falling
      // back to landingRow/landingCol for cavalry) to call game.performAttack
      // — the attacker's own row/col is never consulted, so it's omitted here.
      return {
        unitId: action.unitId,
        action: {
          type: 'attack',
          targetRow: flip(action.targetRow),
          targetCol: action.targetCol,
          landingRow: flip(action.landingRow),
          landingCol: action.landingCol,
          cost: action.cost,
          score: 0,
        },
      };
    case 'craft':
      return { unitId: action.unitId, action: { type: 'craft', index: action.index, score: 0 } };
    case 'craft-armor':
      return { unitId: action.unitId, action: { type: 'craft-armor', index: action.index, score: 0 } };
    case 'search-ruins':
      return { unitId: action.unitId, action: { type: 'draw', score: 0 } };
    case 'castle-heal':
      return { unitId: action.unitId, action: { type: 'castle-heal', score: 0 } };
    // Mage abilities and building have no AIAction of their own: they go to the
    // live game as the engine action itself (AIGameAPI.performEngineAction).
    // Before this they were dropped, so the AI never used its mage or built a
    // bridge even though its search planned on doing so.
    case 'mage-attack':
      return { unitId: action.unitId, action: { type: 'engine', score: 0, server: { ...action, targetRow: flip(action.targetRow) } } };
    case 'mage-burn-bridge':
    case 'build-tower':
    case 'build-bridge':
      return { unitId: action.unitId, action: { type: 'engine', score: 0, server: { ...action, row: flip(action.row) } } };
    case 'mage-ward':
    case 'mage-drain':
    case 'mage-heal':
      return { unitId: action.unitId, action: { type: 'engine', score: 0, server: action } };
    // 'end-turn' / 'resign' / 'draw-artifact' / 'equip-weapon' are not
    // produced by candidateActions/generateActionsForUnit today (no
    // catapult rock-throw action exists either) — nothing to map.
    default:
      return null;
  }
}

/**
 * Run the beam search against a live-game snapshot and return a plan in the
 * exact `{unitId, action}[]` shape `AIPlayer.createTurnPlan` expects, ready
 * to slot into the existing `this.turnPlan` consumption loop unchanged.
 */
export function beamPlanFor(
  game: AIGameAPI,
  me: Player,
  config: BeamDifficultyConfig,
  weights?: AIWeights,
): Array<{ unitId: number; action: AIAction }> {
  const state = snapshotGameState(game);
  // Same entry point as scripts/ladder.mjs, so the difficulty measured there
  // is exactly the one shipped here.
  const actions = planTurnFor(state, me, config, state.turnNumber + 1, weights);

  const plan: Array<{ unitId: number; action: AIAction }> = [];
  for (const a of actions) {
    const entry = toPlanEntry(a, game.player1Bottom);
    if (entry) plan.push(entry);
  }
  return plan;
}
