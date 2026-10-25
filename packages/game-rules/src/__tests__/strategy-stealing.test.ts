import { flipFacing } from '../facing.js';
import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState } from '../apply.js';
import { createMatchSetup } from '../setup.js';
import { mulberry32 } from '../rng.js';
import { ROWS } from '../constants.js';
import type { GameState } from '../state.js';

/**
 * Machine-checked premises of the strategy-stealing theorem for this game:
 *
 *   On a mirror-symmetric map, the SECOND player cannot force a win.
 *
 * Proof sketch: suppose P2 had a strategy S that wins against everything.
 * P1 opens with a pass (end-turn, always legal). The position is now exactly
 * the start position mirrored, with P2 to move — i.e. P1 is now "second" in
 * an identical game and can play S itself, so P1 wins. That contradicts S
 * beating every P1 strategy. Only tie-break asymmetry exists (apply.ts checks
 * P1's capture first) and it only ever favours P1, so it cannot rescue P2.
 *
 * So with perfect play the result is "P1 wins" or "nobody can force a win" —
 * half of the outcome space is eliminated without searching a single node.
 * These tests check the two facts the argument rests on.
 */
function mirror(s: GameState): GameState {
  const flip = (r: number) => ROWS - 1 - r;
  const swap = (p: 1 | 2): 1 | 2 => (p === 1 ? 2 : 1);
  return {
    ...s,
    currentPlayer: swap(s.currentPlayer),
    castleP1Col: s.castleP2Col,
    castleP2Col: s.castleP1Col,
    units: s.units.map((u) => ({ ...u, player: swap(u.player), row: flip(u.row), facing: u.facing && flipFacing(u.facing) })),
    terrain: s.terrain.map((t) => ({ ...t, row: flip(t.row) })),
    towers: s.towers.map((t) => ({ ...t, row: flip(t.row) })),
    hiddenPickups: s.hiddenPickups.map((p) => ({ ...p, row: flip(p.row) })),
  };
}

/** Comparable form: units matched by (player, type, cell), everything else by value. */
function canon(s: GameState): string {
  const units = s.units
    // Mage energy is left out on purpose: it regenerates at the start of its
    // own turn, so the sides start at 10 / 5 to be EQUAL (10) on their first
    // turn (setup.ts) — a raw snapshot is never mirror-equal, and a passing
    // side keeps its unspent energy. Equal first-turn energy is tested below.
    .map((u) => `${u.player}|${u.type}|${u.row},${u.col}|${u.hp}/${u.armor}|${u.movesLeft}|${u.done}`)
    .sort();
  const cells = (xs: { row: number; col: number }[]) => xs.map((x) => `${x.row},${x.col}`).sort();
  return JSON.stringify({
    p: s.currentPlayer,
    c: [s.castleP1Col, s.castleP2Col],
    units,
    terrain: s.terrain.map((t) => `${t.row},${t.col}:${t.type}`).sort(),
    towers: cells(s.towers),
    pickups: s.hiddenPickups.map((p) => `${p.row},${p.col}:${p.name}`).sort(),
    act: s.activatedCount,
    winner: s.winner,
  });
}

/** The real starting army with an empty (hence symmetric) map. */
function symmetricStart(): GameState {
  const setup = createMatchSetup(1);
  return createInitialState({
    mode: 'pvp',
    seed: 1,
    units: setup.units,
    castleP1Col: 8,
    castleP2Col: 8,
    terrain: [],
    hiddenPickups: [],
  });
}

describe('strategy stealing — premises hold in the real rules', () => {
  it('the starting army is mirror-symmetric (P1 ↔ P2 under a row flip)', () => {
    const s = symmetricStart();
    // createMatchSetup places both armies relative to their own castle col.
    const s8 = { ...s, units: s.units.map((u) => ({ ...u, col: u.col - (u.player === 1 ? createMatchSetup(1).castleP1Col : createMatchSetup(1).castleP2Col) + 8 })) };
    expect(canon(mirror({ ...s8, currentPlayer: 2 }))).toBe(canon({ ...s8, currentPlayer: 1 }));
  });

  it('passing is legal and lands exactly on the mirrored start, other side to move', () => {
    const base = symmetricStart();
    const start: GameState = { ...base, units: base.units.map((u) => ({ ...u, col: u.col - (u.player === 1 ? createMatchSetup(1).castleP1Col : createMatchSetup(1).castleP2Col) + 8 })) };
    const pass = applyAction(start, { kind: 'end-turn' }, mulberry32(1));
    if (!pass.ok) throw new Error('end-turn must always be legal');
    const after = pass.value;
    expect(after.winner).toBeNull();
    // After P1's pass: P2 to move in a position identical to the start seen from the other side.
    expect(canon(mirror(after))).toBe(canon(start));
  });

  it('both mages start their first own turn with the same energy', () => {
    const start = symmetricStart();
    const e = (st: GameState, p: 1 | 2) => st.units.find((u) => u.type === 'mage' && u.player === p)?.energy;
    const p2Turn = applyAction(start, { kind: 'end-turn' }, mulberry32(1));
    if (!p2Turn.ok) throw new Error('end-turn must always be legal');
    expect(e(p2Turn.value, 2)).toBe(e(start, 1));
  });
});
