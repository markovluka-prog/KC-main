#!/usr/bin/env node
/**
 * Complete position solver (retrograde analysis, the method used to solve
 * checkers). Unlike solve.mjs it does not walk move SEQUENCES: it enumerates
 * every DISTINCT position reachable from the start, then labels them all:
 *
 *   1. forward pass — breadth-first over every legal action (real rules
 *      engine), each distinct position stored once;
 *   2. terminal positions (someone won) are labelled;
 *   3. backward fixed point — a position is WON if the side to move has an
 *      action into a won-for-it position, LOST if every action leads to a
 *      position won by the opponent; repeat until nothing changes;
 *   4. whatever is still unlabelled is a DRAW: neither side can ever force a
 *      win from there (play can go on forever).
 *
 * The result is exact for every position, cycles included.
 *
 * Usage (from packages/game-rules, after `pnpm build`):
 *   node --max-old-space-size=12000 scripts/tablebase.mjs [--scenario NAME] [--width W]
 * Scenarios: knights (1 vs 1), cavalry (cavalry vs knight), duo (2 vs 1).
 * --width: playable corridor width (columns), rest of the board is mountain.
 */
const rules = await import(new URL('../dist/index.js', import.meta.url).href);
const { applyAction, createInitialState, generateActionsForPlayer, mulberry32, UNIT_TYPES, emptyBackpack } = rules;

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1];
};
const scenario = opt('scenario', 'knights');
const width = Number(opt('width', 4));
const RNG = mulberry32(1);
const END = { kind: 'end-turn' };

function unit(id, player, type, row, col) {
  const T = UNIT_TYPES[type];
  return {
    id, player, type, row, col, maxHp: T.hp, hp: T.hp, startArmor: T.armor, armor: T.armor, maxArmor: T.armor,
    damage: T.damage, maxMoves: T.moves, movesLeft: T.moves, done: false, activated: false,
    visualRow: null, visualCol: null, dying: false, deathProgress: 0, weapon: null, armorGear: null,
    backpack: emptyBackpack(), wardedBy: null,
  };
}

// Castles are 4 wide at col 8; the corridor is centred on them.
const left = 8 - Math.floor((width - 4) / 2);
const terrain = [];
for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) if (c < left || c >= left + width) terrain.push({ row: r, col: c, type: 'mountain' });

const ARMIES = {
  knights: [unit(1, 1, 'knight', 2, 9), unit(2, 2, 'knight', 17, 9)],
  cavalry: [unit(1, 1, 'cavalry', 2, 9), unit(2, 2, 'knight', 17, 9)],
  duo: [unit(1, 1, 'knight', 2, 9), unit(2, 1, 'archer', 1, 10), unit(3, 2, 'knight', 17, 9)],
};
if (!ARMIES[scenario]) throw new Error(`unknown scenario ${scenario}`);
const start = createInitialState({ mode: 'pvp', seed: 1, units: ARMIES[scenario], castleP1Col: 8, castleP2Col: 8, terrain });

/** Everything the rules depend on, as a compact string (exact, collision-free). */
function key(s) {
  let k = `${s.currentPlayer}${s.activatedCount}${s.winner ?? 0}`;
  for (const u of s.units) k += `|${u.id}.${u.row}.${u.col}.${u.hp}.${u.armor}.${u.movesLeft}${u.done ? 1 : 0}${u.activated ? 1 : 0}`;
  return k;
}

// ── 1. forward enumeration ──────────────────────────────────────────────────
const t0 = Date.now();
const index = new Map(); // key → id
const states = []; // id → state
const children = []; // id → Int32Array of child ids
const add = (s) => {
  const k = key(s);
  let id = index.get(k);
  if (id === undefined) {
    id = states.length;
    index.set(k, id);
    states.push(s);
  }
  return id;
};
add(start);
for (let i = 0; i < states.length; i++) {
  const s = states[i];
  if (s.winner !== null) {
    children.push(new Int32Array(0));
    continue;
  }
  const acts = generateActionsForPlayer(s, s.currentPlayer);
  acts.push(END);
  const kids = [];
  for (const a of acts) {
    const r = applyAction(s, a, RNG);
    if (r.ok) kids.push(add(r.value));
  }
  children.push(Int32Array.from(new Set(kids)));
  if (i % 200000 === 0 && i) process.stdout.write(`\r  перебор: ${i.toLocaleString('ru')} позиций обработано, найдено ${states.length.toLocaleString('ru')}   `);
}
const N = states.length;
console.log(`\nВсе позиции перебраны: ${N.toLocaleString('ru')} разных позиций за ${((Date.now() - t0) / 1000).toFixed(1)} с`);

// ── 2–3. retrograde labelling ───────────────────────────────────────────────
// value[i]: 1 = P1 wins, 2 = P2 wins, 0 = unknown (→ draw at the end)
const value = new Uint8Array(N);
const mover = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  mover[i] = states[i].currentPlayer;
  if (states[i].winner !== null) value[i] = states[i].winner;
}
const parents = Array.from({ length: N }, () => []);
for (let i = 0; i < N; i++) for (const c of children[i]) parents[c].push(i);
const remaining = new Int32Array(N); // children not yet known to be lost for the mover
for (let i = 0; i < N; i++) remaining[i] = children[i].length;
const queue = [];
for (let i = 0; i < N; i++) if (value[i]) queue.push(i);
for (let q = 0; q < queue.length; q++) {
  const c = queue[q];
  for (const p of parents[c]) {
    if (value[p]) continue;
    if (value[c] === mover[p]) {
      value[p] = mover[p]; // the mover has a move into a win
      queue.push(p);
    } else if (--remaining[p] === 0) {
      value[p] = mover[p] === 1 ? 2 : 1; // every move loses
      queue.push(p);
    }
  }
}

let p1 = 0, p2 = 0, draw = 0;
for (let i = 0; i < N; i++) value[i] === 1 ? p1++ : value[i] === 2 ? p2++ : draw++;
const v0 = value[0];
console.log(`Итог по всем позициям: P1 выигрывает в ${p1.toLocaleString('ru')}, P2 в ${p2.toLocaleString('ru')}, ничья в ${draw.toLocaleString('ru')}`);
console.log(
  v0 === 0
    ? '✅ Стартовая позиция РЕШЕНА: при идеальной игре НИЧЬЯ — никто не может заставить победу.'
    : `✅ Стартовая позиция РЕШЕНА: при идеальной игре выигрывает игрок ${v0}.`,
);
console.log(`Всего ${((Date.now() - t0) / 1000).toFixed(1)} с.`);
