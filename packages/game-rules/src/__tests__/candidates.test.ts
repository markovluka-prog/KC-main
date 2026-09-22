import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState } from '../apply.js';
import { generateActionsForUnit } from '../actions.js';
import { MAX_NON_LETHAL_ATTACKS, candidateActions, candidateActionsForPlayer } from '../candidates.js';
import { mulberry32 } from '../rng.js';
import type { SerializedUnit } from '../save.js';
import type { GameState } from '../state.js';
import { UNIT_TYPES } from '../constants.js';

function mkUnit(
  over: Partial<SerializedUnit> & Pick<SerializedUnit, 'id' | 'player' | 'type'>,
): SerializedUnit {
  const t = UNIT_TYPES[over.type];
  return {
    row: 0,
    col: 0,
    maxHp: t.hp,
    hp: t.hp,
    startArmor: t.armor,
    armor: t.armor,
    maxArmor: t.armor,
    damage: t.damage,
    maxMoves: t.moves,
    movesLeft: t.moves,
    done: false,
    activated: false,
    visualRow: null,
    visualCol: null,
    dying: false,
    deathProgress: 0,
    weapon: null,
    armorGear: null,
    ...over,
  };
}

function startState(units: SerializedUnit[], seed = 1): GameState {
  return createInitialState({ mode: 'pvp', seed, units });
}

/** Surround (10,10) with enemy knights at every manhattan-3..6 cell — the
 * measured worst case that produced 76 raw catapult actions. High hp/maxHp so
 * none of the resulting attacks are lethal (the non-lethal cap wouldn't be
 * exercised otherwise — every hit would be a kept "never prune a kill"). */
function surroundWithEnemies(): SerializedUnit[] {
  const enemies: SerializedUnit[] = [];
  let id = 2;
  for (let dr = -6; dr <= 6; dr++) {
    for (let dc = -6; dc <= 6; dc++) {
      const dist = Math.abs(dr) + Math.abs(dc);
      if (dist < 3 || dist > 6) continue;
      const r = 10 + dr;
      const c = 10 + dc;
      if (r < 0 || r >= 20 || c < 0 || c >= 20) continue;
      enemies.push(mkUnit({ id: id++, player: 2, type: 'knight', row: r, col: c, hp: 100, maxHp: 100 }));
    }
  }
  return enemies;
}

describe('candidateActions', () => {
  it('returns the same set as generateActionsForUnit when raw fan-out is already small', () => {
    const knight = mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 });
    const enemy = mkUnit({ id: 2, player: 2, type: 'knight', row: 10, col: 11 });
    const state = startState([knight, enemy]);
    expect(candidateActions(state, 1)).toEqual(generateActionsForUnit(state, 1));
  });

  it('caps the measured worst case (catapult surrounded by ~70 enemies) to a bounded action list', () => {
    const cat = mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 10 });
    const state = startState([cat, ...surroundWithEnemies()]);
    const raw = generateActionsForUnit(state, 1);
    expect(raw.length).toBeGreaterThan(70); // sanity: reproduces the measured blow-up

    const filtered = candidateActions(state, 1);
    const attacks = filtered.filter((a) => a.kind === 'attack');
    expect(attacks.length).toBeLessThanOrEqual(MAX_NON_LETHAL_ATTACKS);
    expect(filtered.length).toBeLessThan(raw.length);
  });

  it('every returned action is a subset of generateActionsForUnit (never invents a new legal action)', () => {
    const cat = mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 10 });
    const state = startState([cat, ...surroundWithEnemies()]);
    const raw = generateActionsForUnit(state, 1);
    const filtered = candidateActions(state, 1);
    for (const a of filtered) {
      expect(raw).toContainEqual(a);
    }
  });

  it('never drops a lethal attack, even when it would exceed the non-lethal cap', () => {
    // A 2hp catapult target sitting at range 3, one-shot by our catapult (7
    // damage vs its 1 armor) among a dozen non-lethal knight targets.
    const cat = mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 10 });
    const weakling = mkUnit({ id: 2, player: 2, type: 'catapult', row: 10, col: 13, hp: 1, armor: 0 });
    const filler: SerializedUnit[] = [];
    let id = 3;
    for (let i = 0; i < 10; i++) {
      filler.push(mkUnit({ id: id++, player: 2, type: 'knight', row: 10, col: 14 + (i % 6), armor: 4 }));
    }
    const state = startState([cat, weakling, ...filler]);
    const filtered = candidateActions(state, 1);
    const hitsWeakling = filtered.some(
      (a) => a.kind === 'attack' && a.targetRow === weakling.row && a.targetCol === weakling.col,
    );
    expect(hitsWeakling).toBe(true);
  });

  it('prefers higher-damage non-lethal attacks over lower-damage ones when capping', () => {
    const cat = mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 10, damage: 7 });
    // Every target survives (high armor), but armor values differ so damage-to-armor differs.
    const targets: SerializedUnit[] = [];
    let id = 2;
    const armors = [0, 1, 2, 3, 4, 5, 6]; // 7 distinct absorbed-damage outcomes
    let idx = 0;
    for (let dr = -6; dr <= 6; dr++) {
      for (let dc = -6; dc <= 6; dc++) {
        const dist = Math.abs(dr) + Math.abs(dc);
        if (dist < 3 || dist > 6) continue;
        const r = 10 + dr;
        const c = 10 + dc;
        if (r < 0 || r >= 20 || c < 0 || c >= 20) continue;
        if (idx >= armors.length) continue;
        targets.push(
          mkUnit({ id: id++, player: 2, type: 'knight', row: r, col: c, hp: 100, maxHp: 100, armor: armors[idx]! }),
        );
        idx += 1;
      }
    }
    const state = startState([cat, ...targets]);
    const filtered = candidateActions(state, 1).filter((a) => a.kind === 'attack');
    expect(filtered.length).toBe(MAX_NON_LETHAL_ATTACKS);
    // The kept targets should be the ones with the LEAST armor (most damage through).
    const keptCols = filtered.map((a) => (a as { targetCol: number }).targetCol).sort((a, b) => a - b);
    // lowest-armor targets are armors[0..3] which we assigned to the first 4 valid cells scanned
    expect(keptCols.length).toBe(MAX_NON_LETHAL_ATTACKS);
  });

  it('every candidate action is legal against applyAction', () => {
    const rng = mulberry32(7);
    const cat = mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 10 });
    const state = startState([cat, ...surroundWithEnemies()]);
    for (const action of candidateActions(state, 1)) {
      const result = applyAction(state, action, rng);
      expect(result.ok, JSON.stringify(action)).toBe(true);
    }
  });
});

describe('candidateActionsForPlayer', () => {
  it('flat-maps candidateActions over every actable unit', () => {
    const cat = mkUnit({ id: 1, player: 1, type: 'catapult', row: 10, col: 10 });
    const knight = mkUnit({ id: 2, player: 1, type: 'knight', row: 0, col: 0 });
    const state = startState([cat, knight, ...surroundWithEnemies()]);
    const combined = candidateActionsForPlayer(state, 1);
    const separately = [...candidateActions(state, 1), ...candidateActions(state, 2)];
    expect(combined).toEqual(separately);
  });
});
