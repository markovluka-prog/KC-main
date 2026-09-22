/*
 * Regression tests for the combo short-circuit in createTurnPlan().
 *
 * `comboDetection` runs BEFORE the MCTS and returns immediately when it fires,
 * so a bad combo does not merely score badly — it replaces the entire 1.5s
 * search. Observed in a real game on `hard`: the bot threw two units into a
 * "combo", killed nothing, and lost 9-0. detectCombos accepted any pair whose
 * damage summed to the target's hp, with no check on what the attackers lose.
 */
import { describe, expect, it } from 'vitest';
import { AIPlayer, type AIGameAPI } from '../ai.js';
import { AI_DIFFICULTY, type AIConfig } from '../ai-config.js';

interface TestUnit {
  id: number;
  player: 1 | 2;
  type: string;
  row: number;
  col: number;
  hp: number;
  maxHp: number;
  armor: number;
  maxArmor: number;
  damage: number;
  moves: number;
  maxMoves: number;
  movesLeft: number;
  done: boolean;
  activated: boolean;
}

function unit(over: Partial<TestUnit> & { id: number; player: 1 | 2; row: number; col: number }): TestUnit {
  return {
    type: 'knight',
    hp: 5,
    maxHp: 5,
    armor: 0,
    maxArmor: 0,
    damage: 5,
    moves: 2,
    maxMoves: 2,
    movesLeft: 2,
    done: false,
    activated: false,
    ...over,
  } as TestUnit;
}

/** A game stub that implements the handful of methods the combo path uses:
 *  ownUnits, attackActionsFor, computeDamage and unitAt. */
function makeComboGame(units: TestUnit[], player1Bottom = true): AIGameAPI {
  const noop = (): void => {};
  const alive = (): TestUnit[] => units.filter((u) => u.hp > 0);
  const stub = {
    mode: 'ai' as const,
    currentPlayer: 2,
    winner: null,
    selectedUnit: null,
    pendingWeaponEquip: null,
    pendingCastleHealing: null,
    player1Bottom,
    inventory: { 1: {}, 2: {} },
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    lastEvent: '',
    board: {
      units: alive(),
      unitAt: (r: number, c: number) => alive().find((u) => u.row === r && u.col === c) ?? null,
      isTower: () => false,
      inRuins: () => false,
    },
    isGameActive: () => true,
    ownUnits: (p: 1 | 2) => alive().filter((u) => u.player === p),
    canUnitAct: (u: TestUnit) => !u.done && u.movesLeft > 0,
    // Melee: attack any orthogonally adjacent enemy, landing stays in place.
    attackActionsFor: (u: TestUnit) =>
      alive()
        .filter(
          (e) =>
            e.player !== u.player &&
            Math.abs(e.row - u.row) + Math.abs(e.col - u.col) === 1,
        )
        .map((e) => ({
          row: u.row,
          col: u.col,
          targetRow: e.row,
          targetCol: e.col,
          landingRow: u.row,
          landingCol: u.col,
        })),
    computeDamage: (a: TestUnit, t: TestUnit) => Math.max(0, a.damage - t.armor),
    moveActionsFor: () => [],
    selectUnit: noop,
    clearHighlights: noop,
    forceEndTurn: noop,
    endTurn: noop,
    shouldEndTurn: () => true,
    weaponEquipTargets: () => [],
    equipPendingWeapon: noop,
    canEquipWeaponToUnit: () => false,
    performAttack: () => false,
    performMove: () => false,
    drawArtifact: noop,
    castSpell: noop,
    skipSelected: noop,
    canAfford: () => false,
    renderSidebar: noop,
  };
  return stub as unknown as AIGameAPI;
}

function makeAI(game: AIGameAPI, over: Partial<AIConfig> = {}): AIPlayer {
  const ai = new AIPlayer(game, 2, 'hard');
  ai.setConfig({ ...AI_DIFFICULTY.hard, label: 'test', ...over } as Partial<AIConfig> & {
    label?: string;
  });
  return ai;
}

describe('combo short-circuit', () => {
  it('rejects a combo that hangs both attackers for one kill', () => {
    // Two P2 knights gang up on a 10 hp P1 knight: 5 + 5 damage exactly kills
    // it. But three healthy P1 knights stand adjacent to BOTH attackers, so
    // each one dies on the enemy's reply. This is the shape that lost the game:
    // two units spent, one killed, and the search never got to weigh in.
    const units = [
      unit({ id: 1, player: 2, row: 10, col: 10 }),
      unit({ id: 2, player: 2, row: 10, col: 12 }),
      unit({ id: 3, player: 1, row: 10, col: 11, hp: 10, maxHp: 10 }),
      // The punishers: adjacent to the two attackers' landing squares.
      unit({ id: 4, player: 1, row: 9, col: 10, damage: 9 }),
      unit({ id: 5, player: 1, row: 9, col: 12, damage: 9 }),
      unit({ id: 6, player: 1, row: 11, col: 10, damage: 9 }),
    ];
    const ai = makeAI(makeComboGame(units)) as unknown as {
      detectCombos: (u: TestUnit[]) => Array<{ attackers: unknown[] }>;
      comboIsProfitable: (c: unknown) => boolean;
    };
    const mine = units.filter((u) => u.player === 2);
    const combos = ai.detectCombos(mine);
    const twoUnit = combos.filter((c) => c.attackers.length === 2);
    expect(twoUnit.length).toBeGreaterThan(0); // detector still SEES it
    // ...but none of the suicidal ones may be played instead of the search.
    for (const c of twoUnit) expect(ai.comboIsProfitable(c)).toBe(false);
  });

  it('still takes a free kill where the attacker is safe', () => {
    // A lone 3 hp P1 knight next to a P2 knight, no enemy able to punish.
    const units = [
      unit({ id: 1, player: 2, row: 10, col: 10 }),
      unit({ id: 2, player: 1, row: 10, col: 11, hp: 3, maxHp: 3 }),
    ];
    const ai = makeAI(makeComboGame(units)) as unknown as {
      detectCombos: (u: TestUnit[]) => Array<{ attackers: unknown[] }>;
      comboIsProfitable: (c: unknown) => boolean;
    };
    const combos = ai.detectCombos(units.filter((u) => u.player === 2));
    expect(combos.length).toBeGreaterThan(0);
    expect(ai.comboIsProfitable(combos[0])).toBe(true);
  });

  it('accepts a lone attacker trading itself for a more valuable target', () => {
    // One P2 knight kills a high-value P1 cavalry and dies for it. A single
    // exposed attacker trading UP is a fair trade, not the failure mode.
    const units = [
      unit({ id: 1, player: 2, row: 10, col: 10, hp: 2, maxHp: 2 }),
      unit({ id: 2, player: 1, row: 10, col: 11, type: 'cavalry', hp: 4, maxHp: 4, damage: 6 }),
      unit({ id: 3, player: 1, row: 9, col: 10, damage: 9 }),
    ];
    const ai = makeAI(makeComboGame(units)) as unknown as {
      detectCombos: (u: TestUnit[]) => Array<{ attackers: unknown[] }>;
      comboIsProfitable: (c: unknown) => boolean;
    };
    const combos = ai.detectCombos(units.filter((u) => u.player === 2));
    const solo = combos.filter((c) => c.attackers.length === 1);
    expect(solo.length).toBeGreaterThan(0);
    expect(ai.comboIsProfitable(solo[0])).toBe(true);
  });
});
