/*
 * Tests for the server-side tactical search that backs /api/ai-move when no LLM
 * is reachable.
 *
 * The property that matters most is SAFETY: the search must only ever return
 * actions the client itself listed as legal, and must always produce a plan when
 * units can act. Beyond that these check that it actually plays — takes free
 * kills, avoids walking into death — rather than dumping first actions like the
 * fallback it replaced.
 */
import { describe, expect, it } from 'vitest';
import { searchSettingsFor, searchTurnPlan, } from '../routes/ai-search.js';
function move(row, col) {
    return { type: 'move', row, col, desc: `Move to (${row}, ${col})` };
}
function attack(targetRow, targetCol, landingRow, landingCol) {
    return {
        type: 'attack',
        targetRow,
        targetCol,
        landingRow,
        landingCol,
        desc: `Attack (${targetRow}, ${targetCol})`,
    };
}
function myUnit(over) {
    return {
        type: 'knight',
        row: 10,
        col: 10,
        hp: 5,
        maxHp: 5,
        armor: 1,
        damage: 3,
        movesLeft: 2,
        availableActions: [],
        ...over,
    };
}
function input(over) {
    return {
        myUnits: [],
        enemyUnits: [],
        timeBudgetMs: 150,
        exploration: 1.1,
        selectionTemp: 0,
        ...over,
    };
}
describe('searchTurnPlan — safety invariants', () => {
    it('returns an empty plan when no unit has any available action', () => {
        const plan = searchTurnPlan(input({
            myUnits: [myUnit({ id: 1, availableActions: [] })],
            enemyUnits: [{ id: 9, type: 'knight', row: 2, col: 2, hp: 5, maxHp: 5, armor: 1, damage: 3 }],
        }));
        expect(plan).toEqual([]);
    });
    it('only ever returns actions the caller supplied', () => {
        const legal = [move(9, 10), move(11, 10), attack(10, 11, 10, 10)];
        const plan = searchTurnPlan(input({
            myUnits: [myUnit({ id: 1, row: 10, col: 10, availableActions: legal })],
            enemyUnits: [
                { id: 9, type: 'knight', row: 10, col: 11, hp: 4, maxHp: 4, armor: 0, damage: 3 },
            ],
        }));
        expect(plan.length).toBeGreaterThan(0);
        for (const entry of plan) {
            // Identity check, not deep equality: the exact object must come back, so
            // the route can hand it straight to the client.
            expect(legal).toContain(entry.action);
            expect(entry.unitId).toBe(1);
        }
    });
    it('never acts with the same unit twice in one turn', () => {
        const plan = searchTurnPlan(input({
            myUnits: [
                myUnit({ id: 1, row: 10, col: 10, availableActions: [move(9, 10), move(11, 10)] }),
                myUnit({ id: 2, row: 12, col: 10, availableActions: [move(11, 10), move(13, 10)] }),
            ],
            enemyUnits: [
                { id: 9, type: 'knight', row: 4, col: 10, hp: 5, maxHp: 5, armor: 1, damage: 3 },
            ],
        }));
        const ids = plan.map((p) => p.unitId);
        expect(new Set(ids).size).toBe(ids.length);
    });
    it('does not plan for a unit the caller did not send', () => {
        const plan = searchTurnPlan(input({
            myUnits: [myUnit({ id: 7, row: 10, col: 10, availableActions: [move(9, 10)] })],
            enemyUnits: [
                { id: 9, type: 'knight', row: 4, col: 10, hp: 5, maxHp: 5, armor: 1, damage: 3 },
            ],
        }));
        for (const entry of plan)
            expect(entry.unitId).toBe(7);
    });
});
describe('searchTurnPlan — plays tactically', () => {
    it('takes a free lethal capture instead of moving away', () => {
        const kill = attack(10, 11, 10, 10);
        const plan = searchTurnPlan(input({
            myUnits: [
                myUnit({
                    id: 1,
                    row: 10,
                    col: 10,
                    damage: 5,
                    availableActions: [move(9, 10), move(11, 10), kill],
                }),
            ],
            // 1 HP, no armor — the attack kills outright.
            enemyUnits: [
                { id: 9, type: 'knight', row: 10, col: 11, hp: 1, maxHp: 1, armor: 0, damage: 2 },
            ],
        }));
        expect(plan[0].action).toBe(kill);
    });
    it('prefers killing the more dangerous of two reachable targets', () => {
        const killWeak = attack(10, 11, 10, 10);
        const killStrong = attack(10, 9, 10, 10);
        const plan = searchTurnPlan(input({
            myUnits: [
                myUnit({ id: 1, row: 10, col: 10, damage: 6, availableActions: [killWeak, killStrong] }),
            ],
            enemyUnits: [
                { id: 8, type: 'knight', row: 10, col: 11, hp: 1, maxHp: 1, armor: 0, damage: 1 },
                { id: 9, type: 'knight', row: 10, col: 9, hp: 1, maxHp: 1, armor: 0, damage: 9 },
            ],
        }));
        expect(plan[0].action).toBe(killStrong);
    });
    it('does not step onto a square where an enemy would kill it, given a safe option', () => {
        const suicide = move(10, 11); // adjacent to a unit that one-shots us
        const safe = move(18, 2);
        const plan = searchTurnPlan(input({
            myUnits: [
                myUnit({
                    id: 1,
                    row: 15,
                    col: 5,
                    hp: 2,
                    armor: 0,
                    availableActions: [suicide, safe],
                }),
            ],
            enemyUnits: [
                { id: 9, type: 'knight', row: 10, col: 12, hp: 9, maxHp: 9, armor: 5, damage: 9 },
            ],
        }));
        expect(plan[0].action).toBe(safe);
    });
    it('applies the damage buff when deciding whether an attack is lethal', () => {
        // Base damage 3 vs 4 HP is not lethal; +2 from the buff makes it lethal.
        const strike = attack(10, 11, 10, 10);
        const plan = searchTurnPlan(input({
            myUnits: [
                myUnit({ id: 1, row: 10, col: 10, damage: 3, availableActions: [move(9, 10), strike] }),
            ],
            enemyUnits: [
                { id: 9, type: 'knight', row: 10, col: 11, hp: 4, maxHp: 4, armor: 0, damage: 2 },
            ],
            damageBuff: 2,
        }));
        expect(plan[0].action).toBe(strike);
    });
    it('acts with several units in one turn when each has something to do', () => {
        const plan = searchTurnPlan(input({
            myUnits: [
                myUnit({ id: 1, row: 10, col: 10, damage: 6, availableActions: [attack(10, 11, 10, 10)] }),
                myUnit({ id: 2, row: 14, col: 10, availableActions: [move(13, 10), move(12, 10)] }),
                myUnit({ id: 3, row: 16, col: 10, availableActions: [move(15, 10), move(14, 10)] }),
            ],
            enemyUnits: [
                { id: 9, type: 'knight', row: 10, col: 11, hp: 1, maxHp: 1, armor: 0, damage: 2 },
                { id: 8, type: 'knight', row: 4, col: 10, hp: 5, maxHp: 5, armor: 1, damage: 3 },
            ],
            timeBudgetMs: 250,
        }));
        expect(plan.length).toBeGreaterThan(1);
    });
});
describe('searchTurnPlan — budget and difficulty', () => {
    it('respects its wall-clock budget', () => {
        const budget = 200;
        const t0 = Date.now();
        searchTurnPlan(input({
            myUnits: [
                myUnit({ id: 1, row: 10, col: 10, availableActions: [move(9, 10), move(11, 10), move(10, 9)] }),
                myUnit({ id: 2, row: 12, col: 12, availableActions: [move(11, 12), move(13, 12)] }),
            ],
            enemyUnits: [
                { id: 9, type: 'knight', row: 4, col: 10, hp: 5, maxHp: 5, armor: 1, damage: 3 },
                { id: 8, type: 'archer', row: 5, col: 12, hp: 3, maxHp: 3, armor: 0, damage: 3 },
            ],
            timeBudgetMs: budget,
        }));
        // Bounded overshoot: batches are sized from measured iteration cost.
        expect(Date.now() - t0).toBeLessThan(budget * 4 + 400);
    });
    it('returns a plan even with a near-zero budget', () => {
        const plan = searchTurnPlan(input({
            myUnits: [myUnit({ id: 1, row: 10, col: 10, availableActions: [move(9, 10)] })],
            enemyUnits: [
                { id: 9, type: 'knight', row: 4, col: 10, hp: 5, maxHp: 5, armor: 1, damage: 3 },
            ],
            timeBudgetMs: 0,
        }));
        expect(plan.length).toBeGreaterThan(0);
    });
    it('scales difficulty by budget and decisiveness, not by blundering', () => {
        const easy = searchSettingsFor('easy');
        const medium = searchSettingsFor('medium');
        const hard = searchSettingsFor('hard');
        expect(easy.timeBudgetMs).toBeLessThan(medium.timeBudgetMs);
        expect(medium.timeBudgetMs).toBeLessThan(hard.timeBudgetMs);
        // Exploration falls and the final pick becomes deterministic as difficulty rises.
        expect(easy.exploration).toBeGreaterThan(hard.exploration);
        expect(easy.selectionTemp).toBeGreaterThan(medium.selectionTemp);
        expect(hard.selectionTemp).toBe(0);
    });
    it('unknown difficulty falls back to the medium settings', () => {
        expect(searchSettingsFor('nonsense')).toEqual(searchSettingsFor('medium'));
    });
    it('even the easy preset still takes an obvious free kill', () => {
        // Weakness must come from search budget and variety, never from suicide or
        // from ignoring a gift.
        const kill = attack(10, 11, 10, 10);
        const settings = searchSettingsFor('easy');
        const plan = searchTurnPlan({
            myUnits: [
                myUnit({ id: 1, row: 10, col: 10, damage: 6, availableActions: [move(9, 10), kill] }),
            ],
            enemyUnits: [
                { id: 9, type: 'knight', row: 10, col: 11, hp: 1, maxHp: 1, armor: 0, damage: 2 },
            ],
            ...settings,
        });
        expect(plan[0].action).toBe(kill);
    });
});
