import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState, endTurn } from '../apply.js';
import { evaluate } from '../evaluate.js';
import { planTurn, planTurnWithReply } from '../beam.js';
import { BEAM_DIFFICULTY, toBeamOptions, toReplyOptions, type BeamDifficulty } from '../beam-presets.js';
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

describe('BEAM_DIFFICULTY presets', () => {
  const difficulties: BeamDifficulty[] = ['easy', 'medium', 'hard', 'expert'];

  it('defines all four difficulties with strictly increasing beam width', () => {
    const widths = difficulties.map((d) => BEAM_DIFFICULTY[d].beamWidth);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]!);
    }
  });

  it('only hard/expert use opponent-reply lookahead; easy/medium do not', () => {
    expect(BEAM_DIFFICULTY.easy.reply).toBe(false);
    expect(BEAM_DIFFICULTY.medium.reply).toBe(false);
    expect(BEAM_DIFFICULTY.hard.reply).toBe(true);
    expect(BEAM_DIFFICULTY.expert.reply).toBe(true);
  });

  it('noise strictly decreases as difficulty increases, reaching exactly 0 at hard/expert', () => {
    expect(BEAM_DIFFICULTY.easy.noise).toBeGreaterThan(BEAM_DIFFICULTY.medium.noise);
    expect(BEAM_DIFFICULTY.medium.noise).toBeGreaterThan(BEAM_DIFFICULTY.hard.noise);
    expect(BEAM_DIFFICULTY.hard.noise).toBe(0);
    expect(BEAM_DIFFICULTY.expert.noise).toBe(0);
  });

  it.each(difficulties)('%s: toBeamOptions/toReplyOptions produce a legal, replayable plan', (d) => {
    const config = BEAM_DIFFICULTY[d];
    const attacker = mkUnit({ id: 1, player: 2, type: 'knight', row: 10, col: 10, damage: 5 });
    const victim = mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 11, hp: 3, maxHp: 3 });
    const state = createInitialState({
      mode: 'pvp',
      seed: 7,
      units: [attacker, victim],
      player1Starts: false,
    });

    const actions = config.reply
      ? planTurnWithReply(state, 2, toReplyOptions(config))
      : planTurn(state, 2, toBeamOptions(config));

    expect(actions.length).toBeGreaterThan(0);
    replay(state, actions); // throws (via expect.ok assertions inside) if any action is illegal
  });

  it.each((['medium', 'hard', 'expert'] as BeamDifficulty[]))(
    '%s: finds the obvious free kill (unlike easy, these should not miss it)',
    (d) => {
      const config = BEAM_DIFFICULTY[d];
      const attacker = mkUnit({ id: 1, player: 2, type: 'knight', row: 10, col: 10, damage: 5 });
      const victim = mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 11, hp: 3, maxHp: 3 });
      const state = createInitialState({
        mode: 'pvp',
        seed: 7,
        units: [attacker, victim],
        player1Starts: false,
      });

      const actions = config.reply
        ? planTurnWithReply(state, 2, toReplyOptions(config))
        : planTurn(state, 2, toBeamOptions(config));

      const after = replay(state, actions);
      const victimAfter = after.units.find((u) => u.id === 2);
      expect(!victimAfter || victimAfter.hp <= 0).toBe(true);
    },
  );

  it('easy (beamWidth=1, noise=0.25) never plays an illegal or crashing plan, even though it may miss the kill', () => {
    // Documents the "no blunders, but not sharp" philosophy from ai-config.ts:
    // low beam width + noise means easy can genuinely miss a free kill (it's
    // not required to find it, unlike medium/hard/expert above), but every
    // action it DOES choose must still be legal — replay() itself asserts
    // that on every seed.
    const attacker = mkUnit({ id: 1, player: 2, type: 'knight', row: 10, col: 10, damage: 5 });
    const victim = mkUnit({ id: 2, player: 1, type: 'knight', row: 10, col: 11, hp: 3, maxHp: 3 });
    for (let seed = 1; seed <= 10; seed++) {
      const state = createInitialState({
        mode: 'pvp',
        seed,
        units: [attacker, victim],
        player1Starts: false,
      });
      const actions = planTurn(state, 2, toBeamOptions(BEAM_DIFFICULTY.easy));
      replay(state, actions);
    }
  });

  it("hard's reply-aware search outperforms medium's reply-blind search when a real choice exists", () => {
    // Same scenario as beam.test.ts's "reply lookahead picks the plan that
    // scores better..." test, this time driven entirely through the
    // difficulty presets — the thing a player actually selects — rather than
    // calling planTurn/planTurnWithReply directly with hand-picked options.
    // (The original 6-unit both-attackers-hang scenario no longer
    // discriminates: CASTLE_APPROACH_MULTIPLIER — see evaluate.ts — made even
    // reply-blind medium avoid it on its own. See beam.test.ts's
    // "plain planTurn ALSO now avoids..." regression guard for that case.)
    const units = [
      mkUnit({ id: 1, player: 2, type: 'archer', row: 10, col: 10, damage: 3 }),
      mkUnit({ id: 2, player: 1, type: 'cavalry', row: 10, col: 12, hp: 2, maxHp: 5, armor: 0 }),
      mkUnit({ id: 3, player: 1, type: 'cavalry', row: 9, col: 12, damage: 6, hp: 5 }),
    ];
    const state = createInitialState({ mode: 'pvp', seed: 1, units, player1Starts: false });

    const scoreAfterOpponentReply = (finalState: GameState): number => {
      const afterEndTurn = endTurn(finalState);
      const oppReply = planTurn(afterEndTurn, 1, toBeamOptions(BEAM_DIFFICULTY.medium));
      let s = afterEndTurn;
      const rng = mulberry32(1);
      for (const a of oppReply) {
        const r = applyAction(s, a, rng);
        if (r.ok) s = r.value;
      }
      return evaluate(s, 2);
    };

    const mediumActions = planTurn(state, 2, toBeamOptions(BEAM_DIFFICULTY.medium));
    const mediumScore = scoreAfterOpponentReply(replay(state, mediumActions));

    const hardActions = planTurnWithReply(state, 2, toReplyOptions(BEAM_DIFFICULTY.hard));
    const hardScore = scoreAfterOpponentReply(replay(state, hardActions));

    expect(hardScore).toBeGreaterThan(mediumScore);
  });
});
