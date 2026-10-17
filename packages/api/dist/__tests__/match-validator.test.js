import { describe, expect, it } from 'vitest';
import { parseAction } from '../match/validator.js';
import { createMatch, dispatchAction, joinMatch } from '../match/state.js';
describe('parseAction', () => {
    it('accepts a well-formed move', () => {
        const r = parseAction({ kind: 'move', unitId: 1, row: 5, col: 3, cost: 1 });
        expect(r.ok).toBe(true);
    });
    it('rejects negative coords', () => {
        const r = parseAction({ kind: 'move', unitId: 1, row: -1, col: 3, cost: 1 });
        expect(r.ok).toBe(false);
    });
    it('rejects out-of-range coords', () => {
        const r = parseAction({ kind: 'move', unitId: 1, row: 99, col: 3, cost: 1 });
        expect(r.ok).toBe(false);
    });
    it('rejects unknown kinds', () => {
        const r = parseAction({ kind: 'cheat', unitId: 1 });
        expect(r.ok).toBe(false);
    });
    it('rejects junk payloads', () => {
        expect(parseAction(null).ok).toBe(false);
        expect(parseAction('hi').ok).toBe(false);
        expect(parseAction({}).ok).toBe(false);
    });
    it('accepts a crossbow pierce shot with its targets line', () => {
        const r = parseAction({
            kind: 'attack',
            unitId: 1,
            mode: 'pierce',
            cost: 2,
            targetRow: 5,
            targetCol: 6,
            landingRow: 5,
            landingCol: 5,
            targets: [
                { row: 5, col: 6 },
                { row: 5, col: 7 },
            ],
        });
        expect(r.ok).toBe(true);
    });
    it('accepts a pierce shot with targets omitted (server derives the line)', () => {
        const r = parseAction({
            kind: 'attack',
            unitId: 1,
            mode: 'pierce',
            cost: 2,
            targetRow: 5,
            targetCol: 6,
            landingRow: 5,
            landingCol: 5,
        });
        expect(r.ok).toBe(true);
    });
});
describe('dispatchAction (anti-cheat checks)', () => {
    function setup() {
        const m = createMatch('match-1', 42, 1);
        joinMatch(m, 'user-a', 1);
        joinMatch(m, 'user-b', 2);
        // Replace the seeded roster with one synthetic unit so these anti-cheat
        // checks run on a deterministic, minimal board.
        m.state.units = [];
        m.state.units.push({
            id: 1,
            player: 1,
            type: 'knight',
            row: 5,
            col: 5,
            maxHp: 3,
            hp: 3,
            startArmor: 4,
            armor: 4,
            maxArmor: 4,
            damage: 5,
            maxMoves: 2,
            movesLeft: 2,
            done: false,
            activated: false,
            visualRow: null,
            visualCol: null,
            dying: false,
            deathProgress: 0,
            weapon: null,
            armorGear: null,
            backpack: { 'Металл': 0, 'Амулет': 0, 'Рубин': 0, 'Дерево': 0, 'Стрелы': 0 },
        });
        return m;
    }
    it('rejects action from non-current-player', () => {
        const m = setup();
        const res = dispatchAction(m, 'user-b', {
            kind: 'move',
            unitId: 1,
            row: 5,
            col: 6,
            cost: 1,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('wrong-turn');
    });
    it('accepts action from current player and advances state', () => {
        const m = setup();
        const res = dispatchAction(m, 'user-a', {
            kind: 'move',
            unitId: 1,
            row: 5,
            col: 6,
            cost: 1,
        });
        expect(res.ok).toBe(true);
        expect(m.state.units.find((u) => u.id === 1).col).toBe(6);
    });
    it('rejects resign-as-opponent', () => {
        const m = setup();
        // user-a tries to resign for player 2 (user-b).
        const res = dispatchAction(m, 'user-a', { kind: 'resign', player: 2 });
        expect(res.ok).toBe(false);
    });
    it('refuses dispatch when status is not in_progress', () => {
        const m = createMatch('match-2', 1, 1);
        // No participants joined → status stays 'created'.
        const res = dispatchAction(m, 'user-a', { kind: 'end-turn' });
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('game-over');
    });
});
describe('parseAction — knows every reducer action', () => {
    // Typed as Record<kind, …>: adding a ServerAction kind to @kc/game-rules
    // without listing it here is a compile error, and listing it here without
    // adding it to the zod schema fails below — so the online server can never
    // silently reject an action the client already played.
    const samples = {
        move: { kind: 'move', unitId: 1, row: 1, col: 1, cost: 1 },
        attack: {
            kind: 'attack', unitId: 1, mode: 'pierce', cost: 2, targetRow: 1, targetCol: 1, landingRow: 0, landingCol: 1,
            targets: [{ row: 1, col: 1 }, { row: 2, col: 1 }],
        },
        'end-turn': { kind: 'end-turn' },
        resign: { kind: 'resign', player: 1 },
        craft: { kind: 'craft', unitId: 1, index: 0 },
        'craft-armor': { kind: 'craft-armor', unitId: 1, index: 0 },
        'draw-part': { kind: 'draw-part', unitId: 1 },
        'equip-weapon': { kind: 'equip-weapon', unitId: 1 },
        'search-ruins': { kind: 'search-ruins', unitId: 1 },
        'castle-heal': { kind: 'castle-heal', unitId: 1 },
        'transfer-items': { kind: 'transfer-items', fromUnitId: 1, toUnitId: 2, parts: { 'Дерево': 1 }, weapon: true, armor: true },
        'mage-attack': { kind: 'mage-attack', unitId: 1, targetRow: 1, targetCol: 1, damage: 2 },
        'mage-ward': { kind: 'mage-ward', unitId: 1, toggleUnitIds: [2] },
        'mage-drain': { kind: 'mage-drain', unitId: 1, targetUnitId: 2 },
        'mage-burn-bridge': { kind: 'mage-burn-bridge', unitId: 1, row: 1, col: 1 },
        'mage-heal': { kind: 'mage-heal', unitId: 1, targetUnitId: 2 },
        'throw-rock': { kind: 'throw-rock', unitId: 1, row: 1, col: 1 },
        'build-tower': { kind: 'build-tower', unitId: 1, row: 1, col: 1 },
        'build-bridge': { kind: 'build-bridge', unitId: 1, row: 1, col: 1 },
    };
    for (const [kind, sample] of Object.entries(samples)) {
        it(`accepts ${kind}`, () => {
            const r = parseAction(sample);
            expect(r.ok, r.ok ? '' : r.error).toBe(true);
            // zod drops unknown keys silently — a field the schema forgot would
            // vanish before the reducer sees it, so the parse must be lossless.
            if (r.ok)
                expect(r.value).toEqual(sample);
        });
    }
});
