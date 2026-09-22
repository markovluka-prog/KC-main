import { describe, it } from 'vitest';
import { AI_DIFFICULTY } from '../ai-config.js';
import { applyPlan, makeSearcher, makeState, makeUnit, search, type Player } from './mcts-harness.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The live match was lost because the bot repeatedly left archers where enemy
 * cavalry could one-shot them (archer 3hp/1armor vs cavalry 6dmg => 5 damage).
 * With real stats, does it now keep them out of reach?
 */
describe('hanging units', () => {
  it('does the bot move an archer out of one-shot range?', () => {
    // Bot archer at (8,10). Enemy cavalry at (10,10) has 3 moves, so it can
    // reach and kill next turn. A safe square exists far behind.
    const state = makeState(
      [
        makeUnit({ id: 1, player: 2 as Player, type: 'archer', row: 8, col: 10, hp: 3, armor: 1, damage: 3, maxMoves: 3 }),
        makeUnit({ id: 2, player: 2 as Player, type: 'knight', row: 7, col: 10, hp: 3, armor: 4, damage: 5, maxMoves: 2 }),
        makeUnit({ id: 9, player: 1 as Player, type: 'cavalry', row: 9, col: 10, hp: 5, armor: 3, damage: 6, maxMoves: 3 }),
      ],
      3,
    );
    const ai: any = makeSearcher(2, { ...AI_DIFFICULTY.hard, mctsTimeBudgetMs: 2000, intelligence: 1 } as any, state, true);
    const { plan } = search(ai, state);
    console.log('PLAN:', JSON.stringify(plan.map((p: any) => `${p.unitId}:${p.action.type}@${p.action.row ?? p.action.targetRow},${p.action.col ?? p.action.targetCol}`)));
    // What options did the archer itself have, and how were they scored?
    const arch = state.units.find((u: any) => u.id === 1)!;
    const raw = ai.generateActionsForLightState(state, arch);
    const scored = ai.scoreLightActions(state, arch, raw, 2);
    console.log('archer options (top 5):');
    scored.slice(0, 5).forEach((a: any) =>
      console.log(`   ${a.type}@${a.row ?? a.targetRow},${a.col ?? a.targetCol} score=${a.score}`));
    // Retreating = increasing distance from the cavalry at (9,10).
    const away = scored.filter((a: any) => a.type === 'move' && Math.abs(a.row - 9) + Math.abs(a.col - 10) > 1);
    console.log('best retreat:', away[0] ? `${away[0].row},${away[0].col} score=${away[0].score}` : 'NONE AVAILABLE');
    const after = applyPlan(ai, state, 2, plan);
    const archer = after.units.find((u: any) => u.id === 1);
    const cav = after.units.find((u: any) => u.id === 9)!;
    if (!archer) {
      console.log('archer is GONE (traded away)');
      return;
    }
    const dist = Math.abs(archer.row - cav.row) + Math.abs(archer.col - cav.col);
    console.log(`archer now at ${archer.row},${archer.col}; cavalry at ${cav.row},${cav.col}; manhattan=${dist}`);
    console.log(dist > 3 ? '=> SAFE from the 3-move cavalry' : '=> STILL IN REACH (hanging)');
  });

  it('threat penalty: is a lethal threat scored worse than a scratch?', () => {
    const mk = (hp: number) =>
      makeState(
        [
          makeUnit({ id: 1, player: 2 as Player, type: 'archer', row: 8, col: 10, hp, armor: 1, damage: 3, maxMoves: 3 }),
          makeUnit({ id: 9, player: 1 as Player, type: 'cavalry', row: 8, col: 11, hp: 5, armor: 3, damage: 6, maxMoves: 3 }),
        ],
        3,
      );
    const ai: any = makeSearcher(2, { ...AI_DIFFICULTY.hard } as any, mk(3), true);
    // hp 3 => cavalry deals 5, lethal. hp 9 => same damage, survives.
    const lethal = ai.evaluateLightState(mk(3), 2);
    const survives = ai.evaluateLightState(mk(9), 2);
    console.log('eval when the archer DIES to the threat :', lethal);
    console.log('eval when the archer SURVIVES it        :', survives);
    console.log(lethal < survives ? '=> lethal threat is correctly worse' : '=> NOT distinguished');
  });
});
