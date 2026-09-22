import { describe, it, expect } from 'vitest';
import { AI_DIFFICULTY } from '../ai-config.js';
import { makeSearcher, makeState, makeUnit, type Player } from './mcts-harness.js';

/**
 * A futile attack must not outrank repositioning.
 *
 * (The move-then-attack threat model this file used to test is now opt-in via
 * `accurateThreatModel` — it measured much weaker in real games; see
 * simEnemyCanReach and scripts/ai-gauntlet.ts.)
 */
describe('threat-aware retreat', () => {
  const hardFast = { ...AI_DIFFICULTY.hard, mctsTimeBudgetMs: 1500, intelligence: 1 } as any;

  it('does not rate a zero-damage attack above repositioning', () => {
    // Archer damage 3 vs knight armor 4 => 0 damage. Shooting is pointless and
    // must not outscore moving; this is what pinned the archer in place.
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'archer', row: 8, col: 10, hp: 3, armor: 1, damage: 3, maxMoves: 3 }),
        makeUnit({ id: 9, player: 1 as Player, type: 'knight', row: 8, col: 11, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, hardFast, state, true);
    const archer = state.units.find((u: any) => u.id === 1)!;
    const raw = ai.generateActionsForLightState(state, archer);
    const scored = ai.scoreLightActions(state, archer, raw, 2);
    const bestAttack = scored.find((a: any) => a.type === 'attack');
    const bestMove = scored.find((a: any) => a.type === 'move');
    expect(bestAttack, 'the futile shot should still be generated').toBeDefined();
    expect(bestMove).toBeDefined();
    expect(bestAttack.score).toBeLessThan(bestMove.score);
  });

});
