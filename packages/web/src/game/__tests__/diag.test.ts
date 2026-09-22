import { describe, it } from 'vitest';
import { AI_DIFFICULTY } from '../ai-config.js';
import { makeSearcher, makeState, makeUnit, type Player } from './mcts-harness.js';
describe('diag', () => {
  it('why is entering the castle not chosen', () => {
    const base = () => makeState([
      makeUnit({ id: 1, player: 1 as Player, type: 'knight', row: 4, col: 9, hp: 5, damage: 3 }),
      makeUnit({ id: 2, player: 2 as Player, type: 'knight', row: 14, col: 18, hp: 5, damage: 3 }),
    ]);
    const ai = makeSearcher(1, { ...AI_DIFFICULTY.hard, mctsTimeBudgetMs: 320, intelligence: 1 } as never, base(), true);
    const inner = ai as unknown as Record<string, (...a: unknown[]) => unknown>;
    // Eval of standing at 4,9 vs standing INSIDE the castle at 3,9.
    const s0 = base();
    const s1 = base();
    (s1.units as {id:number;row:number}[]).find((u)=>u.id===1)!.row = 3;
    const plans = inner.generateTopKTurnPlans(base(), 1) as {plan:{unitId:number;action:{type:string;row?:number;col?:number}}[]}[];
    console.log(`generated ${plans.length} plans:`);
    plans.forEach((p,i)=>console.log(`  [${i}] ${p.plan.map((e)=>`${e.action.type}@${e.action.row},${e.action.col}`).join(' ')}`));
    const wins = plans.filter((p)=>p.plan.some((e)=>e.action.row!==undefined && e.action.row<=3));
    console.log(`plans that enter the castle (row<=3): ${wins.length}`);
    // What does the tree do with them?
    inner.mctsBegin();
    for (let i=0;i<50;i++) inner.mctsSlice(20);
    const root = (inner as unknown as {mctsRoot:{children:{visits:number;value:number;solved:boolean;parentPlan:{action:{type:string;row?:number;col?:number}}[]}[]}}).mctsRoot;
    root.children.forEach((c)=>console.log(`  child visits=${c.visits} value=${(c.value/Math.max(1,c.visits)).toFixed(3)} solved=${c.solved} :: ${c.parentPlan.map((e)=>`${e.action.type}@${e.action.row},${e.action.col}`).join(' ')}`));
    const chosen = inner.mctsBestPlan() as {action:{type:string;row?:number;col?:number}}[];
    console.log('CHOSEN:', chosen.map((e)=>`${e.action.type}@${e.action.row},${e.action.col}`).join(' '));
  });
});
