/**
 * Tests for beam-bridge.ts — plan step 6. The critical risk in this module is
 * the player1Bottom row flip: `@kc/game-rules`'s planTurn assumes canonical
 * orientation (player 1 always top), but the live single-player board
 * physically flips every row when player1Bottom is true. Get this wrong and
 * the beam search either plans nonsense (row math on the wrong side of the
 * board) or the resulting plan's coordinates come out flipped and every move
 * the AI "chooses" gets rejected by game.performMove/performAttack.
 */
import { describe, expect, it } from 'vitest';
import { getCastleP1Col, getCastleP2Col, ROWS } from '@kc/game-rules';
import { BEAM_DIFFICULTY } from '@kc/game-rules';
import { Board } from '../Board.js';
import { Unit } from '../Unit.js';
import { beamPlanFor, snapshotGameState, toPlanEntry } from '../beam-bridge.js';
import type { AIGameAPI } from '../ai.js';

/** Build a minimal but real AIGameAPI-shaped stub around a real Board, with
 * only the units the test supplies (autoInit=false skips the default 10v10
 * roster so scenarios stay small and legible). */
function makeGame(player1Bottom: boolean, units: Unit[], currentPlayer: 1 | 2 = 2): AIGameAPI {
  const board = new Board(player1Bottom, false);
  board.units = units;
  board.nextId = Math.max(0, ...units.map((u) => u.id)) + 1;
  const stub = {
    mode: 'ai' as const,
    currentPlayer,
    winner: null,
    player1Bottom,
    activatedCount: 0,
    maxActivatedPerTurn: 3,
    board,
    selectedUnit: null,
    pendingWeaponEquip: null,
    pendingCastleHealing: null,
    inventory: { 1: {}, 2: {} },
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    lastEvent: '',
    droppedItems: [],
    isGameActive: () => true,
    ownUnits: (p: 1 | 2) => units.filter((u) => u.alive() && u.player === p),
    canUnitAct: (u: Unit) => !u.done && u.movesLeft > 0,
    selectUnit: () => {},
    clearHighlights: () => {},
    forceEndTurn: () => {},
    endTurn: () => {},
    shouldEndTurn: () => true,
    weaponEquipTargets: () => [],
    equipPendingWeapon: () => {},
    computeDamage: () => 0,
    moveActionsFor: () => [],
    attackActionsFor: () => [],
    performAttack: () => false,
    performMove: () => false,
    drawArtifact: () => {},
    castSpell: () => {},
    craftWeapon: () => false,
    craftArmor: () => false,
    applyCastleHealing: () => {},
    isUnitInOwnCastle: () => false,
    skipSelected: () => {},
    canAfford: () => false,
    canEquipWeaponToUnit: () => false,
    canEquipGearForPickup: () => false,
    renderSidebar: () => {},
  };
  return stub as unknown as AIGameAPI;
}

describe('snapshotGameState — turn counter', () => {
  it('copies the live turnNumber (the mage first-turn rule depends on it)', () => {
    const game = makeGame(false, [new Unit(1, 2, 'knight', 10, 10)]);
    (game as unknown as { turnNumber: number }).turnNumber = 17;
    expect(snapshotGameState(game).turnNumber).toBe(17);
  });
});

describe('snapshotGameState — orientation normalisation', () => {
  it('player1Bottom=false: physical rows pass through unchanged, castle columns pass through', () => {
    const knight = new Unit(1, 2, 'knight', 10, 10);
    const game = makeGame(false, [knight]);
    const state = snapshotGameState(game);
    const u = state.units.find((x) => x.id === 1)!;
    expect(u.row).toBe(10);
    expect(u.col).toBe(10);
    expect(state.castleP1Col).toBe(getCastleP1Col());
    expect(state.castleP2Col).toBe(getCastleP2Col());
  });

  it('player1Bottom=true: physical rows are flipped into canonical (P1-top) orientation', () => {
    const knight = new Unit(1, 2, 'knight', 10, 10);
    const game = makeGame(true, [knight]);
    const state = snapshotGameState(game);
    const u = state.units.find((x) => x.id === 1)!;
    expect(u.row).toBe(ROWS - 1 - 10);
    expect(u.col).toBe(10); // columns are never flipped
    // castleP1Col/castleP2Col are SWAPPED when player1Bottom, since canonical
    // player 1 = row 0, but physically player 2 sits at the top in this case.
    expect(state.castleP2Col).toBe(getCastleP1Col());
    expect(state.castleP1Col).toBe(getCastleP2Col());
  });

  it('a unit physically AT row 0 (visually top) maps to canonical row ROWS-1 when flipped', () => {
    const knight = new Unit(1, 1, 'knight', 0, 5);
    const game = makeGame(true, [knight]);
    const state = snapshotGameState(game);
    const u = state.units.find((x) => x.id === 1)!;
    expect(u.row).toBe(ROWS - 1);
  });

  it('flipping is its own inverse: flip(flip(row)) === row', () => {
    const knight = new Unit(1, 2, 'knight', 7, 3);
    const gameFlipped = makeGame(true, [knight]);
    const state = snapshotGameState(gameFlipped);
    const flippedRow = state.units[0]!.row;
    const knight2 = new Unit(1, 2, 'knight', flippedRow, 3);
    const gameFlippedAgain = makeGame(true, [knight2]);
    const state2 = snapshotGameState(gameFlippedAgain);
    expect(state2.units[0]!.row).toBe(7);
  });
});

describe('toPlanEntry — action coordinate denormalisation', () => {
  it('denormalises a move action back to physical orientation when player1Bottom', () => {
    const entry = toPlanEntry({ kind: 'move', unitId: 1, row: 5, col: 5, cost: 1 }, true);
    expect(entry).not.toBeNull();
    expect(entry!.action.type).toBe('move');
    expect(entry!.action.row).toBe(ROWS - 1 - 5);
    expect(entry!.action.col).toBe(5);
  });

  it('passes a move action through unchanged when player1Bottom=false', () => {
    const entry = toPlanEntry({ kind: 'move', unitId: 1, row: 5, col: 5, cost: 1 }, false);
    expect(entry!.action.row).toBe(5);
  });

  it('denormalises attack target/landing rows, and omits attacker row/col (unused by executeAction)', () => {
    const entry = toPlanEntry(
      {
        kind: 'attack',
        unitId: 1,
        mode: 'shot',
        cost: 1,
        targetRow: 8,
        targetCol: 9,
        landingRow: 8,
        landingCol: 9,
      },
      true,
    );
    expect(entry!.action.type).toBe('attack');
    expect(entry!.action.targetRow).toBe(ROWS - 1 - 8);
    expect(entry!.action.landingRow).toBe(ROWS - 1 - 8);
    expect(entry!.action.row).toBeUndefined();
  });

  it('maps search-ruins to the AIAction "draw" type', () => {
    const entry = toPlanEntry({ kind: 'search-ruins', unitId: 1 }, false);
    expect(entry!.action.type).toBe('draw');
  });

  it('maps castle-heal, craft, craft-armor 1:1', () => {
    expect(toPlanEntry({ kind: 'castle-heal', unitId: 1 }, false)!.action.type).toBe('castle-heal');
    expect(toPlanEntry({ kind: 'craft', unitId: 1, index: 0 }, false)!.action.type).toBe('craft');
    expect(toPlanEntry({ kind: 'craft-armor', unitId: 1, index: 0 }, false)!.action.type).toBe(
      'craft-armor',
    );
  });

  it('returns null for end-turn/resign — nothing to map', () => {
    expect(toPlanEntry({ kind: 'end-turn' }, false)).toBeNull();
    expect(toPlanEntry({ kind: 'resign', player: 1 }, false)).toBeNull();
  });
});

describe('beamPlanFor — end to end, both orientations', () => {
  it('finds the same tactical outcome (a kill) whether player1Bottom is true or false', () => {
    // Mirror-image setup: same relative shape, opposite physical orientation.
    for (const player1Bottom of [false, true]) {
      const attackerRow = player1Bottom ? ROWS - 1 - 10 : 10;
      const victimRow = player1Bottom ? ROWS - 1 - 10 : 10;
      const attacker = new Unit(1, 2, 'knight', attackerRow, 10);
      attacker.damage = 5;
      const victim = new Unit(2, 1, 'knight', victimRow, 11);
      victim.hp = 3;
      victim.maxHp = 3;
      const game = makeGame(player1Bottom, [attacker, victim], 2);

      const plan = beamPlanFor(game, 2, BEAM_DIFFICULTY.medium);
      expect(plan.length).toBeGreaterThan(0);
      const attackEntry = plan.find((e) => e.action.type === 'attack');
      expect(attackEntry, `player1Bottom=${player1Bottom}`).toBeDefined();
      // The physical target cell must match the victim's actual physical position.
      expect(attackEntry!.action.targetRow).toBe(victimRow);
      expect(attackEntry!.action.targetCol).toBe(11);
    }
  });

  it('every plan entry references a unit that actually exists on the board', () => {
    const attacker = new Unit(1, 2, 'archer', 10, 10);
    const victim = new Unit(2, 1, 'knight', 10, 12);
    victim.hp = 3;
    victim.maxHp = 3;
    const game = makeGame(false, [attacker, victim], 2);
    const plan = beamPlanFor(game, 2, BEAM_DIFFICULTY.hard);
    for (const entry of plan) {
      expect(game.board.units.some((u) => u.id === entry.unitId)).toBe(true);
    }
  });

  it('returns an empty plan when the player has no actable units', () => {
    const done = new Unit(1, 2, 'knight', 10, 10);
    done.done = true;
    const game = makeGame(false, [done], 2);
    const plan = beamPlanFor(game, 2, BEAM_DIFFICULTY.medium);
    expect(plan).toEqual([]);
  });
});
