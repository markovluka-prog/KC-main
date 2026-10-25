import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState } from '../apply.js';
import { planTurn } from '../beam.js';
import { mergeRolloutPicks, selectFinalists } from '../rollout.js';
import { BEAM_DIFFICULTY, isTwoPass, planTurnFinalSliceFor, planTurnFirstPassFor, planTurnFor, toBeamOptions, type BeamDifficulty } from '../beam-presets.js';
import { createMatchSetup } from '../setup.js';
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

function replay(state: GameState, actions: ReturnType<typeof planTurn>): GameState {
  const rng = mulberry32(1);
  let s = state;
  for (const a of actions) {
    const result = applyAction(s, a, rng);
    expect(result.ok, `replaying ${JSON.stringify(a)}`).toBe(true);
    if (result.ok) s = result.value;
  }
  return s;
}

describe('two-pass halving (impossible)', () => {
  it('threads reproduce the sequential plan exactly', () => {
    const cfg = BEAM_DIFFICULTY.impossible;
    expect(isTwoPass(cfg)).toBe(true);
    const state = createInitialState({ mode: 'pvp', seed: 3, ...createMatchSetup(3) });
    const slices = 3;
    const firsts = [0, 1, 2].flatMap((k) => planTurnFirstPassFor(state, 1, cfg, 5, undefined, k, slices));
    const top = selectFinalists(firsts, cfg.rollout!.finalists!);
    const picks = [0, 1, 2].map((k) => planTurnFinalSliceFor(state, 1, cfg, 5, undefined, top, k, slices));
    expect(mergeRolloutPicks(picks).actions).toEqual(planTurnFor(state, 1, cfg, 5));
  }, 120_000);
});

describe('BEAM_DIFFICULTY presets', () => {
  const difficulties: BeamDifficulty[] = ['easy', 'medium', 'hard', 'expert', 'impossible'];

  // The ladder itself (each level beats every weaker one, impossible never
  // loses) is measured by scripts/ladder.mjs — far too slow for a unit test.
  // These pin the SHAPE that measurement validated, so a casual edit can't
  // silently reorder the levels.
  it('easy is the only noisy level; medium plays out fewer, shorter candidates than hard', () => {
    expect(BEAM_DIFFICULTY.easy.noise).toBeGreaterThan(0);
    for (const d of ['medium', 'hard', 'expert', 'impossible'] as const) expect(BEAM_DIFFICULTY[d].noise).toBe(0);
    const m = BEAM_DIFFICULTY.medium.rollout!;
    const h = BEAM_DIFFICULTY.hard.rollout!;
    expect(m.candidates).toBeLessThan(h.candidates);
    expect(m.turns).toBeLessThan(h.turns);
  });

  it('hard and impossible play their candidates out, impossible deeper and wider', () => {
    const h = BEAM_DIFFICULTY.hard.rollout!;
    const i = BEAM_DIFFICULTY.impossible.rollout!;
    expect(h).toBeDefined();
    expect(i).toBeDefined();
    expect(i.candidates).toBeGreaterThan(h.candidates);
    expect(i.turns).toBeGreaterThan(h.turns);
  });

  it.each(difficulties)('%s: planTurnFor produces a legal, replayable plan', (d) => {
    const attacker = mkUnit({ id: 1, player: 2, type: 'knight', row: 10, col: 10, damage: 5, facing: 'right' });
    const victim = mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 11, hp: 3, maxHp: 3 });
    const state = createInitialState({ mode: 'pvp', seed: 7, units: [attacker, victim], player1Starts: false });
    const actions = planTurnFor(state, 2, BEAM_DIFFICULTY[d], 7);
    expect(actions.length).toBeGreaterThan(0);
    replay(state, actions); // throws (via expect.ok assertions inside) if any action is illegal
  });

  it.each(['medium', 'hard', 'expert', 'impossible'] as BeamDifficulty[])(
    '%s: finds the obvious free kill (unlike easy, these should not miss it)',
    (d) => {
      const attacker = mkUnit({ id: 1, player: 2, type: 'knight', row: 10, col: 10, damage: 5, facing: 'right' });
      const victim = mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 11, hp: 3, maxHp: 3 });
      // A defender sits in P1's castle: otherwise the deep levels rightly see
      // that walking into the EMPTY castle wins faster than the kill does.
      const base = createInitialState({ mode: 'pvp', seed: 7, units: [attacker, victim], player1Starts: false });
      const guard = mkUnit({ id: 3, player: 1, type: 'knight', row: 1, col: base.castleP1Col + 1 });
      const state = createInitialState({ mode: 'pvp', seed: 7, units: [attacker, victim, guard], player1Starts: false });
      const after = replay(state, planTurnFor(state, 2, BEAM_DIFFICULTY[d], 7));
      const victimAfter = after.units.find((u) => u.id === 2);
      expect(!victimAfter || victimAfter.hp <= 0).toBe(true);
    },
  );

  it('easy never plays an illegal or crashing plan, even though it may miss the kill', () => {
    const attacker = mkUnit({ id: 1, player: 2, type: 'knight', row: 10, col: 10, damage: 5 });
    const victim = mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 11, hp: 3, maxHp: 3 });
    for (let seed = 1; seed <= 10; seed++) {
      const state = createInitialState({ mode: 'pvp', seed, units: [attacker, victim], player1Starts: false });
      replay(state, planTurn(state, 2, { ...toBeamOptions(BEAM_DIFFICULTY.easy), rngSeed: seed }));
    }
  });

  it('every level plans a legal opening on a real match map, deterministically', () => {
    const state = createInitialState({ mode: 'pvp', seed: 3, ...createMatchSetup(3) });
    for (const d of ['easy', 'medium', 'hard'] as BeamDifficulty[]) {
      const a = planTurnFor(state, 1, BEAM_DIFFICULTY[d], 5);
      expect(planTurnFor(state, 1, BEAM_DIFFICULTY[d], 5)).toEqual(a);
      replay(state, a);
    }
  });
});
