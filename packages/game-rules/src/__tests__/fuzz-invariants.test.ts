import { turnCost } from '../facing.js';
import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState, endTurn, rockTargetAllowed, type ServerAction } from '../apply.js';
import { CATAPULT_MIN_RANGE, catapultMaxRangeFor } from '../moves.js';
import { generateActionsForPlayer } from '../actions.js';
import { createMatchSetup } from '../setup.js';
import { mulberry32 } from '../rng.js';
import { MAGE_MAX_ENERGY, UNIT_TYPES, ARMORS } from '../constants.js';
import { insideBoard } from '../board.js';
import type { GameState } from '../state.js';
import type { SerializedUnit } from '../save.js';
import { emptyBackpack } from '../constants.js';
import type { UnitTypeKey } from '../types.js';

/**
 * Randomised whole-game sweep of the reducer. Every action the legal-action
 * generator offers must be accepted by applyAction (generator ⇔ validator
 * agreement), and after every step the state must satisfy invariants whose
 * violation is exactly the "stale/duplicated state" class of bug: two units
 * on one cell, a unit standing in water, a ward pointing at a dead mage, loot
 * lying in a river, stats out of range, more than 3 activations.
 */
const MAX_ARMOR_GEAR = Math.max(...ARMORS.map((a) => a.amount));

/** Deep-freeze a state so any reducer that writes into it (instead of into
 *  its own copy — the reducer shares untouched objects copy-on-write) throws. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function checkInvariants(s: GameState, where: string): void {
  const cells = new Set<string>();
  const alive = s.units.filter((u) => u.hp > 0);
  expect(alive.length, `${where}: dead units must be removed`).toBe(s.units.length);
  for (const u of alive) {
    const key = `${u.row},${u.col}`;
    expect(insideBoard(u.row, u.col), `${where}: unit ${u.id} off board`).toBe(true);
    expect(cells.has(key), `${where}: two units on ${key}`).toBe(false);
    cells.add(key);
    const blocked = s.terrain.some(
      (t) => t.row === u.row && t.col === u.col && (t.type === 'river' || t.type === 'mountain' || t.type === 'rock'),
    );
    expect(blocked, `${where}: unit ${u.id} on blocked terrain at ${key}`).toBe(false);
    expect(
      s.constructions.some((c) => c.row === u.row && c.col === u.col),
      `${where}: unit ${u.id} inside a build site`,
    ).toBe(false);
    expect(u.hp <= u.maxHp && u.maxHp <= UNIT_TYPES[u.type].hp, `${where}: hp ${u.id}`).toBe(true);
    expect(u.armor >= 0 && u.armor <= u.maxArmor, `${where}: armor ${u.id}`).toBe(true);
    expect(u.maxArmor <= UNIT_TYPES[u.type].armor + MAX_ARMOR_GEAR, `${where}: maxArmor ${u.id}`).toBe(true);
    expect(u.movesLeft >= 0 && u.movesLeft <= u.maxMoves, `${where}: moves ${u.id}`).toBe(true);
    if (u.type === 'mage') {
      expect((u.energy ?? 0) >= 0 && (u.energy ?? 0) <= MAGE_MAX_ENERGY, `${where}: energy ${u.id}`).toBe(true);
    }
    if (u.wardedBy) {
      const mage = alive.find((m) => m.id === u.wardedBy);
      expect(mage?.type, `${where}: unit ${u.id} warded by dead/absent mage ${u.wardedBy}`).toBe('mage');
      expect(mage?.player, `${where}: unit ${u.id} warded by an enemy mage`).toBe(u.player);
    }
  }
  for (const d of s.droppedBackpacks) {
    const wet = s.terrain.some(
      (t) => t.row === d.row && t.col === d.col && (t.type === 'river' || t.type === 'rock' || t.type === 'mountain'),
    );
    expect(wet, `${where}: loot lying on blocked terrain at ${d.row},${d.col}`).toBe(false);
  }
  for (const key of Object.keys(s.bridgeDurability)) {
    const [r, c] = key.split(',').map(Number);
    expect(
      s.terrain.some((t) => t.row === r && t.col === c && t.type === 'bridge'),
      `${where}: durability for a missing bridge ${key}`,
    ).toBe(true);
  }
  expect(s.activatedCount <= 3, `${where}: activations ${s.activatedCount}`).toBe(true);
}

function lootTotal(s: GameState): number {
  let n = 0;
  for (const u of s.units) for (const v of Object.values(u.backpack)) n += v;
  for (const d of s.droppedBackpacks) for (const v of Object.values(d.parts)) n += v;
  for (const p of s.hiddenPickups) if (p.kind === 'part') n += 1;
  return n;
}

describe('reducer fuzz — generator/validator agreement and state invariants', () => {
  it('random games never break an invariant', () => {
    let steps = 0;
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const pick = mulberry32(seed * 7919);
      const setup = createMatchSetup(seed);
      let s = createInitialState({ mode: 'pvp', seed, ...setup });
      // Seed some world features the opening never has, so bridge/ward/rock
      // branches get exercised: a river line with one bridge in mid-board.
      const river = Array.from({ length: 20 }, (_, c) => ({ row: 10, col: c, type: (c === 5 ? 'bridge' : 'river') as 'bridge' | 'river' }));
      s = { ...s, terrain: [...s.terrain.filter((t) => t.row !== 10), ...river], bridgeDurability: { '10,5': 2 } };
      s.units = s.units.filter((u) => u.row !== 10);
      for (const u of s.units) if (u.type !== 'mage') u.backpack['Дерево'] = 2;
      checkInvariants(s, `seed ${seed} start`);
      const partsAtStart = lootTotal(s);

      for (let turn = 0; turn < 40 && s.winner === null; turn += 1) {
        for (let k = 0; k < 8; k += 1) {
          const acts = generateActionsForPlayer(s, s.currentPlayer);
          if (acts.length === 0) break;
          const a: ServerAction = acts[Math.floor(pick.next() * acts.length)]!;
          const res = applyAction(deepFreeze(s), a, mulberry32(seed + steps));
          if (!res.ok) {
            throw new Error(`seed ${seed} turn ${turn}: generator offered ${JSON.stringify(a)} but applyAction said ${res.error.code}: ${res.error.message}`);
          }
          s = res.value;
          steps += 1;
          const tag = a.kind === 'attack' ? `attack:${a.mode}` : a.kind;
          seen.set(tag, (seen.get(tag) ?? 0) + 1);
          checkInvariants(s, `seed ${seed} turn ${turn} after ${a.kind}`);
          // Parts are never created out of thin air (crafting/sinking only removes them).
          expect(lootTotal(s), `seed ${seed}: parts duplicated by ${a.kind}`).toBeLessThanOrEqual(partsAtStart);
          if (s.winner !== null) break;
        }
        s = endTurn(deepFreeze(s));
        checkInvariants(s, `seed ${seed} turn ${turn} after end-turn`);
      }
    }
    expect(steps).toBeGreaterThan(1000);
    if (process.env['FUZZ_STATS']) console.log(JSON.stringify(Object.fromEntries(seen)));
  }, 120_000);
});

const TYPES: UnitTypeKey[] = ['knight', 'cavalry', 'archer', 'catapult', 'crossbow', 'samurai', 'mage'];

/** A crowded mid-board melee: every unit type on both sides, mixed together,
 *  around a river with one bridge — so attacks of every mode, pierce lines
 *  through friends, ward absorbs/overdraws, bridge shots and kills with loot
 *  drops all happen constantly. */
function brawl(seed: number): GameState {
  const rng = mulberry32(seed * 104729);
  const units: SerializedUnit[] = [];
  const taken = new Set<string>();
  const terrain = Array.from({ length: 20 }, (_, c) => ({
    row: 10,
    col: c,
    type: (c % 6 === 2 ? 'bridge' : 'river') as 'bridge' | 'river',
  }));
  for (const t of terrain) taken.add(`${t.row},${t.col}`);
  let id = 1;
  for (const player of [1, 2] as const) {
    for (let i = 0; i < 9; i += 1) {
      const type = TYPES[i % TYPES.length]!;
      let row = 0;
      let col = 0;
      do {
        row = 6 + Math.floor(rng.next() * 9);
        col = 2 + Math.floor(rng.next() * 16);
      } while (taken.has(`${row},${col}`));
      taken.add(`${row},${col}`);
      const t = UNIT_TYPES[type];
      const bp = emptyBackpack();
      bp['Дерево'] = Math.floor(rng.next() * 3);
      bp['Стрелы'] = Math.floor(rng.next() * 3);
      bp['Металл'] = Math.floor(rng.next() * 3);
      units.push({
        id: id++, player, type, row, col,
        maxHp: t.hp, hp: t.hp, startArmor: t.armor, armor: t.armor, maxArmor: t.armor,
        damage: t.damage, maxMoves: t.moves, movesLeft: t.moves, done: false, activated: false,
        visualRow: null, visualCol: null, dying: false, deathProgress: 0,
        weapon: null, armorGear: null, backpack: bp, wardedBy: null,
        ...(type === 'mage' ? { energy: Math.floor(rng.next() * (MAGE_MAX_ENERGY + 1)), maxEnergy: MAGE_MAX_ENERGY, warding: [] } : {}),
      });
    }
  }
  // Pre-ward a few units so absorbs and overdraws start right away.
  for (const u of units) {
    const mage = units.find((m) => m.type === 'mage' && m.player === u.player);
    if (mage && u.id !== mage.id && rng.next() < 0.4) u.wardedBy = mage.id;
  }
  const bridgeDurability: Record<string, number> = {};
  for (const t of terrain) if (t.type === 'bridge') bridgeDurability[`${t.row},${t.col}`] = 2;
  return createInitialState({ mode: 'pvp', seed, units, terrain, bridgeDurability, castleP1Col: 0, castleP2Col: 16 });
}

describe('reducer fuzz — crowded melee', () => {
  it('constant fighting never breaks an invariant', () => {
    const seen = new Map<string, number>();
    let steps = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const pick = mulberry32(seed * 31337);
      let s = brawl(seed);
      checkInvariants(s, `brawl ${seed} start`);
      const partsAtStart = lootTotal(s);
      for (let turn = 0; turn < 30 && s.winner === null; turn += 1) {
        for (let k = 0; k < 10; k += 1) {
          const acts = generateActionsForPlayer(s, s.currentPlayer);
          if (acts.length === 0) break;
          // Actions the generator doesn't offer (the AI never plays them) are
          // probed directly: the reducer must accept exactly the legal ones.
          const r = pick.next();
          const mine = s.units.filter((u) => u.player === s.currentPlayer);
          if (r < 0.1) {
            const cat = mine.find((u) => u.type === 'catapult' && !u.done && u.movesLeft >= 1);
            if (cat && (cat.activated || s.activatedCount < 3)) {
              const row = Math.floor(pick.next() * 20);
              const col = Math.floor(pick.next() * 20);
              const dist = Math.abs(row - cat.row) + Math.abs(col - cat.col);
              const onTower = s.towers.some((t) => t.row === cat.row && t.col === cat.col);
              const legal =
                cat.movesLeft >= 1 + turnCost(cat, row, col) && // aiming behind: +1 to turn round
                dist >= CATAPULT_MIN_RANGE && dist <= catapultMaxRangeFor(onTower) && rockTargetAllowed(s, row, col);
              const res = applyAction(s, { kind: 'throw-rock', unitId: cat.id, row, col }, mulberry32(1));
              expect(res.ok, `brawl ${seed}: throw-rock to ${row},${col} legal=${legal}`).toBe(legal);
              if (res.ok) {
                s = res.value;
                seen.set('throw-rock', (seen.get('throw-rock') ?? 0) + 1);
                checkInvariants(s, `brawl ${seed} after throw-rock`);
              }
              continue;
            }
          } else if (r < 0.2) {
            const from = mine[Math.floor(pick.next() * mine.length)];
            const to = from && mine.find((u) => u.id !== from.id && Math.max(Math.abs(u.row - from.row), Math.abs(u.col - from.col)) <= 1);
            if (from && to) {
              const res = applyAction(
                s,
                { kind: 'transfer-items', fromUnitId: from.id, toUnitId: to.id, parts: { 'Дерево': from.backpack['Дерево'] }, weapon: !!from.weapon, armor: !!from.armorGear },
                mulberry32(1),
              );
              if (res.ok) {
                s = res.value;
                seen.set('transfer-items', (seen.get('transfer-items') ?? 0) + 1);
                checkInvariants(s, `brawl ${seed} after transfer`);
                expect(lootTotal(s), `brawl ${seed}: transfer changed the part count`).toBeLessThanOrEqual(partsAtStart);
              }
              continue;
            }
          }
          // Bias toward attacks/abilities so fights actually happen.
          const fights = acts.filter((a) => a.kind !== 'move');
          const pool = fights.length > 0 && pick.next() < 0.7 ? fights : acts;
          const a: ServerAction = pool[Math.floor(pick.next() * pool.length)]!;
          const res = applyAction(deepFreeze(s), a, mulberry32(seed + steps));
          if (!res.ok) {
            throw new Error(`brawl ${seed} turn ${turn}: generator offered ${JSON.stringify(a)} but applyAction said ${res.error.code}: ${res.error.message}`);
          }
          s = res.value;
          steps += 1;
          const tag = a.kind === 'attack' ? `attack:${a.mode}` : a.kind;
          seen.set(tag, (seen.get(tag) ?? 0) + 1);
          checkInvariants(s, `brawl ${seed} turn ${turn} after ${JSON.stringify(a)}`);
          expect(lootTotal(s), `brawl ${seed}: parts duplicated by ${a.kind}`).toBeLessThanOrEqual(partsAtStart);
          if (s.winner !== null) break;
        }
        s = endTurn(deepFreeze(s));
        checkInvariants(s, `brawl ${seed} turn ${turn} after end-turn`);
      }
    }
    if (process.env['FUZZ_STATS']) console.log(JSON.stringify(Object.fromEntries(seen)));
    for (const mode of ['throw-rock', 'transfer-items', 'attack:shot', 'attack:jump', 'attack:l-attack', 'attack:pierce', 'mage-attack', 'mage-ward', 'mage-drain']) {
      expect(seen.get(mode) ?? 0, `fuzz never exercised ${mode}`).toBeGreaterThan(0);
    }
  }, 300_000);
});

describe('applyMove accepts exactly the generator\'s moves', () => {
  it('no extra and no missing moves, every unit type, river leaps included', () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const s = brawl(seed);
      for (const player of [1, 2] as const) {
        const st = { ...s, currentPlayer: player };
        const legal = new Set(
          generateActionsForPlayer(st, player)
            .filter((a) => a.kind === 'move')
            .map((a) => (a.kind === 'move' ? `${a.unitId}:${a.row},${a.col}:${a.cost}` : '')),
        );
        for (const u of st.units.filter((x) => x.player === player)) {
          for (let dr = -4; dr <= 4; dr += 1) {
            for (let dc = -4; dc <= 4; dc += 1) {
              for (let cost = 1; cost <= 3; cost += 1) {
                const a = { kind: 'move' as const, unitId: u.id, row: u.row + dr, col: u.col + dc, cost };
                const ok = applyAction(st, a, mulberry32(1)).ok;
                expect(ok, `${u.type} ${u.id}@${u.row},${u.col} → ${a.row},${a.col} cost ${cost}`).toBe(
                  legal.has(`${u.id}:${a.row},${a.col}:${cost}`),
                );
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
  });
});
