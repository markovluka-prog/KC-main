/*
 * Unit tests for AI search internals introduced in the Phase 2 AI overhaul.
 * The methods we exercise (`applyEndOfTurn`, `lightStateHash`, `planSignature`,
 * `cloneLightState`) are private. We poke into them via `as any` because the
 * full AIGameAPI mock needed for `searchBestPlan` is large and the value of
 * isolating these primitives outweighs the type laundering.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AIPlayer, type AIGameAPI } from '../ai.js';

type Player = 1 | 2;

// Minimal AIGameAPI stub. None of the tested methods reach into the game,
// so most fields can stay as no-op placeholders. Cast to `unknown` then
// AIGameAPI to silence the structural mismatch — the search code under
// test never touches the unused surface.
function makeStubGame(): AIGameAPI {
  const noop = (): void => {};
  const stub = {
    mode: 'ai' as const,
    currentPlayer: 1 as Player,
    winner: null,
    selectedUnit: null,
    pendingWeaponEquip: null,
    pendingCastleHealing: null,
    inventory: { 1: {}, 2: {} },
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    lastEvent: '',
    board: { units: [], unitAt: () => null, isTower: () => false, inRuins: () => false },
    isGameActive: () => true,
    ownUnits: () => [],
    canUnitAct: () => false,
    selectUnit: noop,
    clearHighlights: noop,
    forceEndTurn: noop,
    endTurn: noop,
    shouldEndTurn: () => true,
    weaponEquipTargets: () => [],
    equipPendingWeapon: noop,
    computeDamage: () => 0,
    moveActionsFor: () => [],
    attackActionsFor: () => [],
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

interface LightUnit {
  id: number;
  player: Player;
  type: 'knight' | 'archer' | 'cavalry';
  row: number;
  col: number;
  hp: number;
  armor: number;
  damage: number;
  maxMoves: number;
  movesLeft: number;
  done: boolean;
  maxHp: number;
  maxArmor: number;
}

interface LightState {
  units: LightUnit[];
  shieldTurns: Record<Player, number>;
  damageBuff: Record<Player, number>;
}

function makeUnit(overrides: Partial<LightUnit> & Pick<LightUnit, 'id' | 'player'>): LightUnit {
  return {
    type: 'knight',
    row: 0,
    col: 0,
    hp: 3,
    armor: 1,
    damage: 2,
    maxMoves: 2,
    movesLeft: 0,
    done: true,
    maxHp: 3,
    maxArmor: 1,
    ...overrides,
  };
}

function makeState(overrides: Partial<LightState> = {}): LightState {
  return {
    units: [],
    shieldTurns: { 1: 0, 2: 0 },
    damageBuff: { 1: 0, 2: 0 },
    ...overrides,
  };
}

describe('AIPlayer search internals', () => {
  let ai: AIPlayer;

  beforeEach(() => {
    ai = new AIPlayer(makeStubGame(), 1, 'hard');
  });

  describe('applyEndOfTurn', () => {
    it('resets done and refills movesLeft for opponent units, leaves ending side as-is', () => {
      const state = makeState({
        units: [
          makeUnit({ id: 1, player: 1, done: true, movesLeft: 0 }),
          makeUnit({ id: 2, player: 2, done: true, movesLeft: 0, maxMoves: 3 }),
        ],
      });
      const out: LightState = (
        ai as unknown as { applyEndOfTurn: (s: LightState, p: Player) => LightState }
      ).applyEndOfTurn(state, 1);
      // Player 1 (ending) is unchanged.
      const p1 = out.units.find((u) => u.id === 1)!;
      expect(p1.done).toBe(true);
      expect(p1.movesLeft).toBe(0);
      // Player 2 (next) is refreshed.
      const p2 = out.units.find((u) => u.id === 2)!;
      expect(p2.done).toBe(false);
      expect(p2.movesLeft).toBe(3);
    });

    it('decrements shieldTurns and damageBuff for the ending player only', () => {
      const state = makeState({
        shieldTurns: { 1: 2, 2: 1 },
        damageBuff: { 1: 3, 2: 0 },
      });
      const out: LightState = (ai as any).applyEndOfTurn(state, 1);
      expect(out.shieldTurns[1]).toBe(1);
      expect(out.shieldTurns[2]).toBe(1);
      expect(out.damageBuff[1]).toBe(2);
      expect(out.damageBuff[2]).toBe(0);
    });

    it('does not go below zero on already-expired buffs', () => {
      const state = makeState({ shieldTurns: { 1: 0, 2: 0 }, damageBuff: { 1: 0, 2: 0 } });
      const out: LightState = (ai as any).applyEndOfTurn(state, 1);
      expect(out.shieldTurns[1]).toBe(0);
      expect(out.damageBuff[1]).toBe(0);
    });

    it('returns a fresh state — original is not mutated', () => {
      const state = makeState({
        units: [makeUnit({ id: 1, player: 2, done: true, movesLeft: 0 })],
      });
      const out: LightState = (ai as any).applyEndOfTurn(state, 1);
      // Originals stay at done=true, movesLeft=0.
      expect(state.units[0]!.done).toBe(true);
      expect(state.units[0]!.movesLeft).toBe(0);
      // Copy has reset values.
      expect(out.units[0]!.done).toBe(false);
    });

    it('skips dead opponent units when refreshing', () => {
      const state = makeState({
        units: [
          makeUnit({ id: 1, player: 2, hp: 0, done: true, movesLeft: 0 }),
          makeUnit({ id: 2, player: 2, hp: 3, done: true, movesLeft: 0 }),
        ],
      });
      const out: LightState = (ai as any).applyEndOfTurn(state, 1);
      const dead = out.units.find((u) => u.id === 1)!;
      const alive = out.units.find((u) => u.id === 2)!;
      expect(dead.done).toBe(true);
      expect(alive.done).toBe(false);
    });
  });

  describe('lightStateHash', () => {
    it('returns the same hash for an identical state', () => {
      const s1 = makeState({
        units: [makeUnit({ id: 1, player: 1, row: 0, col: 0 })],
      });
      const s2 = makeState({
        units: [makeUnit({ id: 1, player: 1, row: 0, col: 0 })],
      });
      const h1 = (ai as any).lightStateHash(s1, 1);
      const h2 = (ai as any).lightStateHash(s2, 1);
      expect(h1).toBe(h2);
    });

    it('is invariant to unit ordering in the input array', () => {
      const s1 = makeState({
        units: [makeUnit({ id: 1, player: 1 }), makeUnit({ id: 2, player: 1, col: 1 })],
      });
      const s2 = makeState({
        units: [makeUnit({ id: 2, player: 1, col: 1 }), makeUnit({ id: 1, player: 1 })],
      });
      expect((ai as any).lightStateHash(s1, 1)).toBe((ai as any).lightStateHash(s2, 1));
    });

    it('changes when a unit moves', () => {
      const s1 = makeState({ units: [makeUnit({ id: 1, player: 1, row: 0, col: 0 })] });
      const s2 = makeState({ units: [makeUnit({ id: 1, player: 1, row: 0, col: 1 })] });
      expect((ai as any).lightStateHash(s1, 1)).not.toBe((ai as any).lightStateHash(s2, 1));
    });

    it('changes when whose-turn-it-is changes', () => {
      const s = makeState({ units: [makeUnit({ id: 1, player: 1 })] });
      expect((ai as any).lightStateHash(s, 1)).not.toBe((ai as any).lightStateHash(s, 2));
    });

    it('excludes dead units (hp <= 0) from the hash', () => {
      const live = makeState({ units: [makeUnit({ id: 1, player: 1, hp: 3 })] });
      const withCorpse = makeState({
        units: [makeUnit({ id: 1, player: 1, hp: 3 }), makeUnit({ id: 99, player: 2, hp: 0 })],
      });
      expect((ai as any).lightStateHash(live, 1)).toBe((ai as any).lightStateHash(withCorpse, 1));
    });

    it('reflects shieldTurns and damageBuff', () => {
      const s = makeState({ units: [makeUnit({ id: 1, player: 1 })] });
      const hashA = (ai as any).lightStateHash(s, 1);
      const sShield = { ...s, shieldTurns: { 1: 2, 2: 0 } };
      const hashB = (ai as any).lightStateHash(sShield, 1);
      expect(hashA).not.toBe(hashB);
    });
  });

  describe('cloneLightState', () => {
    it('produces an independent copy — mutating clone does not touch original', () => {
      const orig = makeState({
        units: [makeUnit({ id: 1, player: 1, hp: 3 })],
        shieldTurns: { 1: 1, 2: 0 },
      });
      const copy: LightState = (ai as any).cloneLightState(orig);
      copy.units[0]!.hp = 0;
      copy.shieldTurns[1] = 99;
      expect(orig.units[0]!.hp).toBe(3);
      expect(orig.shieldTurns[1]).toBe(1);
    });
  });

  describe('planSignature', () => {
    it('returns identical signatures for identical plans', () => {
      const plan = [{ unitId: 1, action: { type: 'move' as const, row: 5, col: 3, score: 0 } }];
      const sig1 = (ai as any).planSignature(plan);
      const sig2 = (ai as any).planSignature([{ ...plan[0] }]);
      expect(sig1).toBe(sig2);
    });

    it('differs across different actions', () => {
      const planA = [{ unitId: 1, action: { type: 'move' as const, row: 5, col: 3, score: 0 } }];
      const planB = [{ unitId: 1, action: { type: 'move' as const, row: 5, col: 4, score: 0 } }];
      expect((ai as any).planSignature(planA)).not.toBe((ai as any).planSignature(planB));
    });

    it('order matters — different sequences produce different signatures', () => {
      const planA = [
        { unitId: 1, action: { type: 'move' as const, row: 5, col: 3, score: 0 } },
        { unitId: 2, action: { type: 'move' as const, row: 6, col: 3, score: 0 } },
      ];
      const planB = [
        { unitId: 2, action: { type: 'move' as const, row: 6, col: 3, score: 0 } },
        { unitId: 1, action: { type: 'move' as const, row: 5, col: 3, score: 0 } },
      ];
      expect((ai as any).planSignature(planA)).not.toBe((ai as any).planSignature(planB));
    });
  });

  describe('AIPlayer construction', () => {
    it('uses the requested difficulty config', () => {
      const easy = new AIPlayer(makeStubGame(), 1, 'easy');
      const hard = new AIPlayer(makeStubGame(), 1, 'hard');
      expect((easy as any).config.minimaxDepth).toBe(1);
      expect((hard as any).config.minimaxDepth).toBe(5);
    });

    it('setDifficulty re-resolves the config', () => {
      const a = new AIPlayer(makeStubGame(), 1, 'easy');
      expect((a as any).config.searchBreadth).toBe(5);
      a.setDifficulty('hard');
      expect((a as any).config.searchBreadth).toBe(28);
    });

    it('falls back to medium for unknown difficulty', () => {
      const a = new AIPlayer(makeStubGame(), 1, 'medium');
      a.setDifficulty('nonexistent');
      expect((a as any).config.minimaxDepth).toBe(3);
    });
  });

  describe('setConfig strength knobs', () => {
    // Story presets in main.ts predate intelligence/strategyWeight/trustSearch.
    // They must NOT silently inherit medium's tuning, or an early "Новичок"
    // fight would search as hard as a late-game one.
    const preset = (mctsTimeBudgetMs: number) => ({
      label: 'story',
      useMCTS: true,
      mctsTimeBudgetMs,
      searchTimeBudgetMs: 120,
    });

    it('keeps a weak preset weak instead of inheriting medium', () => {
      const a = new AIPlayer(makeStubGame(), 1, 'medium');
      a.setConfig(preset(80)); // Новичок
      expect((a as any).config.intelligence).toBe(1);
      expect((a as any).config.trustSearch).toBe(false);
    });

    it('scales intelligence up for a strong preset', () => {
      const a = new AIPlayer(makeStubGame(), 1, 'medium');
      a.setConfig(preset(800)); // Мастер
      expect((a as any).config.intelligence).toBe(6);
      expect((a as any).config.trustSearch).toBe(true);
    });

    it('produces a monotonic curve across the story ladder', () => {
      const iq = (ms: number) => {
        const a = new AIPlayer(makeStubGame(), 1, 'medium');
        a.setConfig(preset(ms));
        return (a as any).config.intelligence as number;
      };
      // Новичок ≤ Ученик ≤ Воин ≤ Тактик ≤ Мастер
      expect(iq(80)).toBeLessThanOrEqual(iq(150));
      expect(iq(150)).toBeLessThanOrEqual(iq(280));
      expect(iq(280)).toBeLessThanOrEqual(iq(450));
      expect(iq(450)).toBeLessThanOrEqual(iq(800));
    });

    it('never overrides an explicitly supplied intelligence', () => {
      const a = new AIPlayer(makeStubGame(), 1, 'medium');
      a.setConfig({ ...preset(800), intelligence: 1 });
      expect((a as any).config.intelligence).toBe(1);
    });
  });
});
