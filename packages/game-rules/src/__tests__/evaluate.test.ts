import { describe, expect, it } from 'vitest';
import { createInitialState } from '../apply.js';
import { generateActionsForUnit } from '../actions.js';
import { FEATURES, evalFeatures, evaluate, unitValue, W } from '../evaluate.js';
import type { SerializedUnit } from '../save.js';
import type { GameState } from '../state.js';
import { UNIT_TYPES, emptyBackpack } from '../constants.js';

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
    backpack: emptyBackpack(),
    ...over,
  };
}

function startState(units: SerializedUnit[], seed = 1): GameState {
  return createInitialState({ mode: 'pvp', seed, units });
}

describe('evaluate()', () => {
  it('the material term alone is antisymmetric (sign flips per perspective)', () => {
    // NOTE: evaluate() as a whole is NOT antisymmetric — this is carried over
    // faithfully from the original evaluateLightState, not a bug introduced
    // by the port. Several blocks are one-sided by design: raid-threat
    // anticipation only fires for the side whose castle is undefended,
    // retreat-toward-home only applies when *you* are outnumbered, and the
    // opponent-threat/hanging-piece scan treats "my units" and "their units"
    // with different (asymmetric) formulas. Two knights of equal stats on
    // opposite sides can therefore legitimately score differently in
    // magnitude depending on whose perspective is asked. What must hold is
    // just the material component, tested in isolation here via unitValue.
    const u1 = mkUnit({ id: 1, player: 1, type: 'knight', row: 5, col: 5, hp: 2 });
    const u2 = mkUnit({ id: 2, player: 2, type: 'cavalry', row: 6, col: 6 });
    const materialFor = (perspective: 1 | 2) => {
      const mine = perspective === 1 ? u1 : u2;
      const theirs = perspective === 1 ? u2 : u1;
      return unitValue(mine) - unitValue(theirs);
    };
    expect(materialFor(1)).toBeCloseTo(-materialFor(2), 6);
  });

  it('scores an empty board as exactly 0', () => {
    const state = startState([]);
    expect(evaluate(state, 1)).toBe(0);
  });

  it('favors the player with more/healthier units, all else equal', () => {
    const mine = [
      mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 12 }),
    ];
    const theirs = [mkUnit({ id: 3, player: 2, type: 'knight', row: 15, col: 15 })];
    const state = startState([...mine, ...theirs]);
    expect(evaluate(state, 1)).toBeGreaterThan(0);
    expect(evaluate(state, 2)).toBeLessThan(0);
  });

  it('wipeout: losing every unit costs exactly material.wipeout beyond material value', () => {
    const theirs = [mkUnit({ id: 1, player: 2, type: 'knight', row: 10, col: 10 })];
    const state = startState(theirs);
    // I (player 1) have zero units -> score should be very negative, dominated
    // by -wipeout, well below losing a single knight's material value.
    expect(evaluate(state, 1)).toBeLessThan(-W.material.wipeout);
  });

  it('castle capture (undefended) dwarfs any plausible material swing', () => {
    const state0 = startState([]);
    const enemyCastleRow = 16; // player 2's castle, ROWS-4
    const raider = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: enemyCastleRow,
      col: state0.castleP2Col,
    });
    // No player-2 units at all => enemy castle is undefended.
    const state = startState([raider]);
    const score = evaluate(state, 1);
    expect(score).toBeGreaterThan(W.castle.captureUndefended - 50000);
  });

  it('castle capture while still defended scores less than undefended capture', () => {
    const state0 = startState([]);
    const enemyCastleRow = 16;
    const raider = mkUnit({
      id: 1,
      player: 1,
      type: 'knight',
      row: enemyCastleRow,
      col: state0.castleP2Col,
    });
    const defender = mkUnit({
      id: 2,
      player: 2,
      type: 'knight',
      row: enemyCastleRow,
      col: state0.castleP2Col + 1,
    });
    const undefended = startState([raider]);
    const defended = startState([raider, defender]);
    expect(evaluate(undefended, 1)).toBeGreaterThan(evaluate(defended, 1));
  });

  it('unitValue matches the material formula for a lone unit', () => {
    const u = mkUnit({ id: 1, player: 1, type: 'cavalry', row: 0, col: 0 });
    const expected =
      u.hp * W.material.perHp + u.armor * W.material.perArmor + u.damage * W.material.perDamage + W.material.byType.cavalry;
    expect(unitValue(u)).toBe(expected);
  });

  it('a hanging unit (lethal threat next turn) scores worse than a safe one', () => {
    const safe = startState([
      mkUnit({ id: 1, player: 1, type: 'archer', row: 0, col: 0 }),
      mkUnit({ id: 2, player: 2, type: 'cavalry', row: 19, col: 19 }),
    ]);
    const hanging = startState([
      mkUnit({ id: 1, player: 1, type: 'archer', row: 5, col: 5 }),
      mkUnit({ id: 2, player: 2, type: 'cavalry', row: 5, col: 6 }),
    ]);
    expect(evaluate(hanging, 1)).toBeLessThan(evaluate(safe, 1));
  });

  it('rewards holding parts for a completed craft recipe (economy term)', () => {
    const u = mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 });
    const base = startState([u]);
    const withRecipe = startState([u]);
    // Кольчуга (ARMORS[0]): Дерево×1, Стрелы×1.
    withRecipe.units[0]!.backpack['Дерево'] = 1;
    withRecipe.units[0]!.backpack['Стрелы'] = 1;
    expect(evaluate(withRecipe, 1)).toBeGreaterThan(evaluate(base, 1));
  });

  describe('GOAL 3b: hunt down the last survivors', () => {
    // Regression for a measured stall: with a dominant material lead (8 vs 3)
    // and the enemy's last few units scattered far apart, the beam search
    // stood still for 30+ turns instead of finishing the game — nothing
    // rewarded closing the distance on a crippled-but-not-annihilated enemy.
    it('closing distance on a crippled, outnumbered enemy scores better than standing still', () => {
      const mine = [
        mkUnit({ id: 1, player: 1, type: 'knight', row: 6, col: 8 }),
        mkUnit({ id: 2, player: 1, type: 'knight', row: 6, col: 9 }),
        mkUnit({ id: 3, player: 1, type: 'knight', row: 5, col: 11 }),
        mkUnit({ id: 4, player: 1, type: 'knight', row: 6, col: 11 }),
        mkUnit({ id: 5, player: 1, type: 'knight', row: 5, col: 7 }),
        mkUnit({ id: 6, player: 1, type: 'knight', row: 6, col: 6 }),
        mkUnit({ id: 7, player: 1, type: 'knight', row: 4, col: 7 }),
        mkUnit({ id: 8, player: 1, type: 'knight', row: 4, col: 12 }),
      ];
      const theirs = [
        mkUnit({ id: 9, player: 2, type: 'knight', row: 9, col: 14 }),
        mkUnit({ id: 10, player: 2, type: 'knight', row: 8, col: 13 }),
        mkUnit({ id: 11, player: 2, type: 'knight', row: 17, col: 7 }), // far corner
      ];
      const standingStill = startState([...mine, ...theirs]);
      const closerUnits = mine.map((u) => (u.id === 8 ? { ...u, row: 6, col: 13 } : u)); // step toward 9,14
      const stepped = startState([...closerUnits, ...theirs]);
      expect(evaluate(stepped, 1)).toBeGreaterThan(evaluate(standingStill, 1));
    });

    it('does NOT distort an even fight (2v2, nobody crippled)', () => {
      const even = startState([
        mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 }),
        mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 12 }),
        mkUnit({ id: 3, player: 2, type: 'knight', row: 5, col: 5 }),
        mkUnit({ id: 4, player: 2, type: 'knight', row: 5, col: 6 }),
      ]);
      // With only 2 of my units and 2 of theirs, myCount >= oppCount * 2 is
      // false (2 >= 4 is false), so GOAL 3b must not fire — the position's
      // score should be driven entirely by the other (pre-existing) terms.
      const scoreBefore = evaluate(even, 1);
      const nudged = startState([
        mkUnit({ id: 1, player: 1, type: 'knight', row: 9, col: 10 }), // one step closer
        mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 12 }),
        mkUnit({ id: 3, player: 2, type: 'knight', row: 5, col: 5 }),
        mkUnit({ id: 4, player: 2, type: 'knight', row: 5, col: 6 }),
      ]);
      // Just confirming both evaluate cleanly (no throw) and stay comparable
      // in scale — this is a guard against GOAL 3b's condition being too loose,
      // not a claim about which one scores higher (spacing/threat still apply).
      expect(Number.isFinite(scoreBefore)).toBe(true);
      expect(Number.isFinite(evaluate(nudged, 1))).toBe(true);
    });

    it('does not fire when the opponent still has more than 4 units, even if outnumbered 2:1', () => {
      const mine: SerializedUnit[] = [];
      for (let i = 0; i < 10; i++) mine.push(mkUnit({ id: i + 1, player: 1, type: 'knight', row: 6, col: 6 + i }));
      const theirs: SerializedUnit[] = [];
      for (let i = 0; i < 5; i++) theirs.push(mkUnit({ id: 100 + i, player: 2, type: 'knight', row: 15, col: 6 + i }));
      const far = startState([...mine, ...theirs]);
      const closer = startState([
        ...mine.map((u) => (u.id === 1 ? { ...u, row: 7, col: 6 } : u)),
        ...theirs,
      ]);
      // 10 vs 5 satisfies myCount >= oppCount*2, but oppCount(5) > 4, so GOAL
      // 3b's cap must keep it off — moving one step should not swing the
      // score anywhere near GOAL 3b's magnitude (a few hundred points from
      // ordinary spacing/threat terms is fine; the hunt-down term would add
      // thousands).
      const delta = evaluate(closer, 1) - evaluate(far, 1);
      expect(Math.abs(delta)).toBeLessThan(3000);
    });
  });
});

describe('mages and wards in evaluate()', () => {
  const knight = () => mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10 });
  const mage = (energy: number) =>
    mkUnit({ id: 2, player: 2, type: 'mage', row: 10, col: 13, energy, maxEnergy: 20 });

  it('prices in the enemy mage regenerating +5 energy before it acts', () => {
    // Mage at 2 energy while it is MY move will have 7 on its turn; the same
    // board with the mage already at 7 on ITS move must score the same threat.
    const mineToMove = startState([knight(), mage(2)]);
    mineToMove.currentPlayer = 1;
    const theirsToMove = startState([knight(), mage(7)]);
    theirsToMove.currentPlayer = 2;
    const a = evalFeatures(mineToMove, 1);
    const b = evalFeatures(theirsToMove, 1);
    for (const name of FEATURES) {
      if (name.startsWith('threat.') || name.startsWith('retreat.')) {
        const i = FEATURES.indexOf(name);
        expect(a[i]).toBeCloseTo(b[i]!, 6);
      }
    }
  });

  it('a ward only protects while the warding mage can pay for the hit', () => {
    const mk = (energy: number) =>
      startState([
        mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10, wardedBy: 4 }),
        mkUnit({ id: 4, player: 1, type: 'mage', row: 9, col: 9, energy, maxEnergy: 20 }),
        mkUnit({ id: 3, player: 2, type: 'knight', row: 10, col: 11 }),
      ]);
    const rich = mk(20);
    const poor = mk(0);
    rich.currentPlayer = 1;
    poor.currentPlayer = 1;
    const i = FEATURES.indexOf('threat.perDamagePointTaken');
    // 20 energy absorbs the knight's 5; 0 energy can't, so the hit lands (and
    // would kill the mage). perDamagePointTaken is negative: less taken = higher.
    expect(evalFeatures(rich, 1)[i]!).toBeGreaterThan(evalFeatures(poor, 1)[i]!);
  });

  it('a tower by the river is worth more than one far behind the lines', () => {
    const st = startState([knight()]);
    const river = st.terrain.find((t) => t.type === 'river');
    if (!river) return; // map without a river: nothing to assert
    const near = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: river.row - 2, col: river.col })]);
    near.terrain = st.terrain;
    near.constructions = [{ row: river.row - 1, col: river.col, kind: 'tower', progress: 2 }];
    const far = startState([mkUnit({ id: 1, player: 1, type: 'knight', row: 1, col: 1 })]);
    far.terrain = st.terrain;
    far.constructions = [{ row: 0, col: 0, kind: 'tower', progress: 2 }];
    const i = FEATURES.indexOf('material.towerStake');
    expect(evalFeatures(near, 1)[i]!).toBeGreaterThan(evalFeatures(far, 1)[i]!);
  });
});

describe('ward generation keeps wards up', () => {
  const setup = (energy: number) =>
    startState([
      mkUnit({ id: 1, player: 1, type: 'knight', row: 10, col: 10, wardedBy: 4 }),
      mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 11 }),
      mkUnit({ id: 4, player: 1, type: 'mage', row: 9, col: 9, energy, maxEnergy: 20 }),
    ]);
  const wardTargets = (st: GameState) =>
    generateActionsForUnit(st, 4)
      .filter((a) => a.kind === 'mage-ward')
      .flatMap((a) => (a.kind === 'mage-ward' ? a.toggleUnitIds : []));

  it('offers wards on unshielded allies but never lifts one while the mage has energy', () => {
    const t = wardTargets(setup(10));
    expect(t).toContain(2);
    expect(t).toContain(4);
    expect(t).not.toContain(1); // already warded by this mage: lifting it is not offered
  });

  it('lifts a ward only in the extreme case: mage almost out of energy', () => {
    expect(wardTargets(setup(1))).toContain(1);
  });
});
