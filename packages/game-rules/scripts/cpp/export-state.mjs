#!/usr/bin/env node
/**
 * Export a GameState for the C++ engine (kc.cpp) as plain text, and — with
 * --perft D — the exact JS-engine perft counts for depths 1..D, so the C++
 * port can be checked against the real rules number for number.
 *
 *   node export-state.mjs --seed 1 > start.txt
 *   node export-state.mjs --brawl 3 --perft 3 > brawl3.txt
 *
 * Format (whitespace separated):
 *   KCSTATE 1
 *   player activated castleP1Col castleP2Col
 *   cells: 400 numbers (bits 0-2 terrain 0 plain 1 river 2 mountain 3 bridge 4 rock,
 *          bit 3 tower, bits 4-5 bridge durability, bits 6-7 site 0/1 tower/2 bridge)
 *   U n, then per unit: id player type row col hp maxHp armor maxArmor startArmor damage
 *          maxMoves movesLeft done activated energy maxEnergy wardedBy
 *          b0 b1 b2 b3 b4 weapon(0/1 sword/2 bow) armorGear(0/1 mail/2 plate)
 *   P n, then per pickup: row col kind(0 part,1 weapon,2 armor) name(index)
 *   D n, then per dropped pack: row col b0..b4 weapon armorGear
 *   PERFT k c1 .. ck   (optional)
 */
const rules = await import(new URL('../../dist/index.js', import.meta.url).href);
const { createInitialState, createMatchSetup, applyAction, generateActionsForPlayer, mulberry32, UNIT_TYPES, emptyBackpack, MAGE_MAX_ENERGY } = rules;

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1];
};

const TYPES = ['knight', 'cavalry', 'archer', 'catapult', 'crossbow', 'samurai', 'mage'];
const PARTS = ['Металл', 'Амулет', 'Рубин', 'Дерево', 'Стрелы'];
const WEAP = { 'Солнечный меч': 1, 'Синий лук': 2 };
const ARM = { 'Кольчуга': 1, 'Латы': 2 };

function unit(id, player, type, row, col, rng) {
  const T = UNIT_TYPES[type];
  const b = emptyBackpack();
  if (rng) {
    b['Дерево'] = Math.floor(rng.next() * 3);
    b['Стрелы'] = Math.floor(rng.next() * 3);
    b['Металл'] = Math.floor(rng.next() * 3);
    b['Рубин'] = Math.floor(rng.next() * 2);
    b['Амулет'] = Math.floor(rng.next() * 2);
  }
  const u = {
    id, player, type, row, col, maxHp: T.hp, hp: T.hp, startArmor: T.armor, armor: T.armor, maxArmor: T.armor,
    damage: T.damage, maxMoves: T.moves, movesLeft: T.moves, done: false, activated: false,
    visualRow: null, visualCol: null, dying: false, deathProgress: 0, weapon: null, armorGear: null,
    backpack: b, wardedBy: null,
  };
  if (type === 'mage') {
    u.maxEnergy = MAGE_MAX_ENERGY;
    u.energy = rng ? Math.floor(rng.next() * (MAGE_MAX_ENERGY + 1)) : MAGE_MAX_ENERGY;
    u.warding = [];
  }
  return u;
}

/** Crowded mid-board fight: every type, river with bridges, wards, loot — exercises every rule. */
function brawl(seed) {
  const rng = mulberry32(seed * 104729);
  const terrain = Array.from({ length: 20 }, (_, c) => ({ row: 10, col: c, type: c % 6 === 2 ? 'bridge' : 'river' }));
  const taken = new Set(terrain.map((t) => `${t.row},${t.col}`));
  const units = [];
  let id = 1;
  for (const player of [1, 2]) {
    for (let i = 0; i < 9; i++) {
      let row, col;
      do {
        row = 6 + Math.floor(rng.next() * 9);
        col = 2 + Math.floor(rng.next() * 16);
      } while (taken.has(`${row},${col}`));
      taken.add(`${row},${col}`);
      units.push(unit(id++, player, TYPES[i % TYPES.length], row, col, rng));
    }
  }
  for (const u of units) {
    const mage = units.find((m) => m.type === 'mage' && m.player === u.player);
    if (mage && mage.id !== u.id && rng.next() < 0.4) u.wardedBy = mage.id;
  }
  // a little loot on the ground and buried
  const hiddenPickups = [
    { row: 5, col: 3, kind: 'part', name: 'Рубин' },
    { row: 9, col: 4, kind: 'weapon', name: 'Солнечный меч' },
    { row: 11, col: 15, kind: 'armor', name: 'Латы' },
  ].filter((p) => !taken.has(`${p.row},${p.col}`));
  const s = createInitialState({
    mode: 'pvp', seed, units, terrain, castleP1Col: 0, castleP2Col: 16,
    towers: [{ row: 8, col: 4 }], bridgeDurability: Object.fromEntries(terrain.filter((t) => t.type === 'bridge').map((t) => [`${t.row},${t.col}`, 2])),
    hiddenPickups,
  });
  s.droppedBackpacks = [{ row: 13, col: 1, parts: { ...emptyBackpack(), 'Металл': 2 }, weapon: null, armorGear: { name: 'Кольчуга', icon: 'armor_mail', amount: 2, allowedTypes: null, forbidTypes: null, archerOnly: false } }].filter((d) => !taken.has(`${d.row},${d.col}`));
  return s;
}

const s = opt('brawl', null) ? brawl(Number(opt('brawl'))) : createInitialState({ mode: 'pvp', seed: Number(opt('seed', 1)), ...createMatchSetup(Number(opt('seed', 1))) });

// ---- write ----
const cell = new Array(400).fill(0);
const T = { river: 1, mountain: 2, bridge: 3, rock: 4 };
for (const t of s.terrain) cell[t.row * 20 + t.col] = (cell[t.row * 20 + t.col] & ~7) | T[t.type];
for (const t of s.towers) cell[t.row * 20 + t.col] |= 8;
for (const [k, v] of Object.entries(s.bridgeDurability)) {
  const [r, c] = k.split(',').map(Number);
  cell[r * 20 + c] |= Math.min(3, v) << 4;
}
for (const c of s.constructions) cell[c.row * 20 + c.col] |= (c.kind === 'tower' ? 1 : 2) << 6;

const out = ['KCSTATE 1', `${s.currentPlayer} ${s.activatedCount} ${s.castleP1Col} ${s.castleP2Col}`, cell.join(' ')];
out.push(`U ${s.units.length}`);
for (const u of s.units) {
  out.push([
    u.id, u.player, TYPES.indexOf(u.type), u.row, u.col, u.hp, u.maxHp, u.armor, u.maxArmor, u.startArmor, u.damage,
    u.maxMoves, u.movesLeft, u.done ? 1 : 0, u.activated ? 1 : 0, u.energy ?? 0, u.maxEnergy ?? 0, u.wardedBy ?? 0,
    ...PARTS.map((p) => u.backpack[p] ?? 0), u.weapon ? WEAP[u.weapon.name] : 0, u.armorGear ? ARM[u.armorGear.name] : 0,
  ].join(' '));
}
out.push(`P ${s.hiddenPickups.length}`);
for (const p of s.hiddenPickups) {
  const kind = p.kind === 'part' ? 0 : p.kind === 'weapon' ? 1 : 2;
  const name = kind === 0 ? PARTS.indexOf(p.name) : kind === 1 ? WEAP[p.name] : ARM[p.name];
  out.push(`${p.row} ${p.col} ${kind} ${name}`);
}
out.push(`D ${s.droppedBackpacks.length}`);
for (const d of s.droppedBackpacks) {
  out.push([d.row, d.col, ...PARTS.map((p) => d.parts[p] ?? 0), d.weapon ? WEAP[d.weapon.name] : 0, d.armorGear ? ARM[d.armorGear.name] : 0].join(' '));
}

const perftD = Number(opt('perft', 0));
if (perftD) {
  const RNG = mulberry32(1);
  const END = { kind: 'end-turn' };
  const perft = (st, d) => {
    if (d === 0 || st.winner !== null) return 1;
    let n = 0;
    const acts = generateActionsForPlayer(st, st.currentPlayer);
    acts.push(END);
    for (const a of acts) {
      const r = applyAction(st, a, RNG);
      if (r.ok) n += perft(r.value, d - 1);
    }
    return n;
  };
  const counts = [];
  for (let d = 1; d <= perftD; d++) counts.push(perft(s, d));
  out.push(`PERFT ${perftD} ${counts.join(' ')}`);
}
console.log(out.join('\n'));
