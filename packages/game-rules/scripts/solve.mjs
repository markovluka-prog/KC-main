#!/usr/bin/env node
/**
 * Exhaustive game-tree solver for Knights & Castles (2 players).
 *
 * Walks EVERY legal action sequence (each move/attack/ability/craft/build/…,
 * plus "end turn") from a position until someone wins, using the real rules
 * engine (@kc/game-rules dist). It proves the outcome:
 *   P1 wins / P2 wins / not decided within the depth searched so far.
 *
 * Exhaustive but not wasteful:
 *   - transposition table: a position reached by different move orders is
 *     solved once (the biggest saving — most orderings commute);
 *   - proof cut-off: once the side to move has a proven win, its remaining
 *     alternatives cannot change the result and are skipped;
 *   - iterative deepening: depth (in actions) grows 1, 2, 3 … so the shortest
 *     forced win is found first, and the search runs until it is solved or
 *     stopped;
 *   - all CPU cores: root actions are spread across worker threads.
 *
 * Usage (from packages/game-rules, after `pnpm build`):
 *   node scripts/solve.mjs                      # starting position (seed 1)
 *   node scripts/solve.mjs --seed 7
 *   node scripts/solve.mjs --demo               # small endgame, solved to a win
 *   node scripts/solve.mjs --position pos.json  # any GameState saved as JSON
 *   node scripts/solve.mjs --max-depth 12 --workers 4
 *   node scripts/solve.mjs --perft 4            # literally count ALL sequences to depth 4
 *
 * Ctrl+C stops it and prints the last completed result.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rules = await import(new URL('../dist/index.js', import.meta.url).href);
const { applyAction, createInitialState, createMatchSetup, generateActionsForPlayer, mulberry32 } = rules;

const END_TURN = { kind: 'end-turn' };
const RNG = mulberry32(1); // nothing in the generated action set rolls dice

/** Every legal action for the side to move, plus ending the turn. */
function actionsOf(s) {
  const out = generateActionsForPlayer(s, s.currentPlayer);
  out.push(END_TURN);
  return out;
}

function step(s, a) {
  const r = applyAction(s, a, RNG);
  return r.ok ? r.value : null;
}

/** 53-bit FNV-style hash of everything the rules depend on. */
function key(s) {
  let h1 = 0x811c9dc5 ^ s.currentPlayer;
  let h2 = 0x01000193 ^ (s.activatedCount * 31 + (s.winner ?? 0));
  const mix = (x) => {
    h1 = Math.imul(h1 ^ x, 0x01000193);
    h2 = Math.imul(h2 ^ (x + 0x9e3779b9), 0x85ebca6b);
  };
  const str = (t) => {
    for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i));
  };
  for (const u of s.units) {
    mix(u.id);
    mix(u.row * 32 + u.col);
    mix(u.hp * 64 + u.armor * 4 + (u.done ? 2 : 0) + (u.activated ? 1 : 0));
    mix(u.maxArmor * 64 + u.damage);
    mix(u.movesLeft * 256 + (u.energy ?? 0));
    mix(u.wardedBy ?? 0);
    const b = u.backpack;
    mix(b['Металл'] | (b['Амулет'] << 4) | (b['Рубин'] << 8) | (b['Дерево'] << 12) | (b['Стрелы'] << 16));
    if (u.weapon) str(u.weapon.name);
    if (u.armorGear) str(u.armorGear.name);
  }
  for (const t of s.terrain) if (t.type !== 'river' && t.type !== 'mountain') mix(t.row * 32 + t.col + (t.type === 'rock' ? 4096 : 8192));
  for (const t of s.towers) mix(t.row * 32 + t.col + 16384);
  for (const c of s.constructions) mix(c.row * 32 + c.col + c.progress * 1024 + (c.kind === 'tower' ? 99 : 77));
  for (const k in s.bridgeDurability) {
    str(k);
    mix(s.bridgeDurability[k]);
  }
  for (const d of s.droppedBackpacks) {
    mix(d.row * 32 + d.col + 50000);
    for (const p in d.parts) mix(d.parts[p]);
    if (d.weapon) str(d.weapon.name);
    if (d.armorGear) str(d.armorGear.name);
  }
  for (const p of s.hiddenPickups) mix(p.row * 32 + p.col + 70000);
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}

// ─────────────────────────────── search core ────────────────────────────────
// Values are from player 1's point of view: +1 = P1 forced win, -1 = P2 forced
// win, 0 = not decided within the remaining depth.
const TT_LIMIT = 6_000_000;
// key → ±1 for a proven result, or UNKNOWN_BASE + depth for "searched this
// deep, still undecided" (kept well clear of ±1 so the two never mix).
let tt = new Map();
const UNKNOWN_BASE = 1000;
let nodes = 0;

/** The worker's search loop is synchronous, so timers never fire inside it —
 *  report progress from the search itself, every 65 536 positions. */
function tick() {
  if ((++nodes & 0xffff) === 0 && parentPort) parentPort.postMessage({ type: 'nodes', nodes });
}

function solve(s, depth) {
  tick();
  if (s.winner !== null) return s.winner === 1 ? 1 : -1;
  if (depth === 0) return 0;
  const k = key(s);
  const e = tt.get(k);
  if (e !== undefined) {
    if (e === 1 || e === -1) return e; // proven, valid at any depth
    if (e - UNKNOWN_BASE >= depth) return 0; // already searched this deep without a result
  }
  const want = s.currentPlayer === 1 ? 1 : -1;
  const acts = actionsOf(s);
  // Children are expanded once; an immediate win short-circuits everything.
  const kids = [];
  for (const a of acts) {
    const c = step(s, a);
    if (!c) continue;
    if (c.winner !== null && (c.winner === 1 ? 1 : -1) === want) {
      store(k, want);
      return want;
    }
    kids.push(c);
  }
  let unknown = false;
  for (const c of kids) {
    const v = solve(c, depth - 1);
    if (v === want) {
      store(k, want);
      return want;
    }
    if (v === 0) unknown = true;
  }
  const v = unknown ? 0 : -want;
  store(k, v === 0 ? UNKNOWN_BASE + depth : v);
  return v;
}

function store(k, v) {
  if (tt.size >= TT_LIMIT) tt = new Map(); // memory guard: start a fresh table
  tt.set(k, v);
}

/** Literal count of every action sequence to `depth` (no table, no cut-offs). */
function perft(s, depth) {
  tick();
  if (depth === 0 || s.winner !== null) return 1;
  let n = 0;
  for (const a of actionsOf(s)) {
    const c = step(s, a);
    if (c) n += perft(c, depth - 1);
  }
  return n;
}

// ─────────────────────────────── worker side ────────────────────────────────
if (!isMainThread) {
  const root = workerData.root;
  const rootActs = actionsOf(root);
  parentPort.on('message', (msg) => {
    const child = step(root, rootActs[msg.index]);
    let v;
    if (msg.mode === 'perft') v = child ? perft(child, msg.depth) : 0;
    else v = child === null ? null : child.winner !== null ? (child.winner === 1 ? 1 : -1) : solve(child, msg.depth);
    parentPort.postMessage({ type: 'done', index: msg.index, depth: msg.depth, v, nodes, tt: tt.size });
  });
}

// ──────────────────────────────── main side ─────────────────────────────────
if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? def : args[i + 1];
  };
  const flag = (name) => args.includes(`--${name}`);
  const workersN = Number(opt('workers', availableParallelism()));
  const maxDepth = Number(opt('max-depth', Infinity));
  const perftDepth = opt('perft', null);

  let root;
  if (opt('position', null)) root = JSON.parse(readFileSync(opt('position'), 'utf8'));
  else if (flag('demo')) root = demoPosition();
  else {
    const seed = Number(opt('seed', 1));
    root = createInitialState({ mode: 'pvp', seed, ...createMatchSetup(seed) });
  }

  const rootActs = actionsOf(root);
  const mover = root.currentPlayer;
  const want = mover === 1 ? 1 : -1;
  console.log(
    `Позиция: ход игрока ${mover}, юнитов ${root.units.length}, вариантов первого действия ${rootActs.length}, потоков ${workersN}`,
  );

  const workers = [];
  const workerNodes = new Array(workersN).fill(0);
  const t0 = Date.now();
  let lastLine = '';
  for (let w = 0; w < workersN; w++) {
    const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { root } });
    wk.on('message', (m) => {
      if (m.nodes !== undefined) workerNodes[w] = m.nodes;
    });
    workers.push(wk);
  }
  const totalNodes = () => workerNodes.reduce((a, b) => a + b, 0);
  // --json: machine-readable progress for run_full_search.py.
  const json = flag('json');
  const emit = (o) => console.log(JSON.stringify(o));
  let curDepth = 0;
  let curDone = 0;
  const ticker = setInterval(() => {
    const sec = (Date.now() - t0) / 1000;
    if (json) emit({ t: 'progress', depth: curDepth, done: curDone, total: rootActs.length, nodes: totalNodes(), sec });
    else process.stdout.write(`\r  ${lastLine} | узлов ${fmt(totalNodes())} | ${fmt(totalNodes() / sec)}/с | ${sec.toFixed(0)} с   `);
  }, 1000);

  /** Run one depth over all root actions in parallel; resolves with per-action values. */
  function runDepth(depth, mode) {
    return new Promise((resolve) => {
      const results = new Array(rootActs.length);
      let next = 0;
      let doneCount = 0;
      let decided = false;
      curDepth = depth + 1;
      curDone = 0;
      const feed = (wk) => {
        if (decided || next >= rootActs.length) return;
        wk.postMessage({ index: next++, depth, mode });
      };
      for (const wk of workers) {
        const onMsg = (m) => {
          if (m.type !== 'done' || m.depth !== depth) return;
          results[m.index] = m.v;
          doneCount++;
          curDone = doneCount;
          if (mode === 'solve' && m.v === want && !decided) {
            decided = true; // the mover already has a forced win
            for (const x of workers) x.off('message', x.__h);
            resolve(results);
            return;
          }
          if (doneCount === rootActs.length) {
            for (const x of workers) x.off('message', x.__h);
            resolve(results);
          } else feed(wk);
        };
        wk.__h = onMsg;
        wk.on('message', onMsg);
        feed(wk);
      }
    });
  }

  const finish = (code) => {
    clearInterval(ticker);
    for (const w of workers) w.terminate();
    process.exit(code);
  };
  process.on('SIGINT', () => {
    console.log('\nОстановлено.');
    finish(0);
  });

  if (perftDepth !== null) {
    for (let d = 1; d <= Number(perftDepth); d++) {
      lastLine = `перебор всех комбинаций, глубина ${d}`;
      const res = await runDepth(d - 1, 'perft');
      const total = res.reduce((a, b) => a + (b ?? 0), 0);
      console.log(`\nГлубина ${d}: ${fmt(total)} последовательностей действий (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
    }
    finish(0);
  }

  let best = null;
  for (let d = 1; d <= maxDepth; d++) {
    lastLine = `глубина ${d}`;
    const res = await runDepth(d - 1, 'solve');
    const winIdx = res.findIndex((v) => v === want);
    const allLose = res.every((v) => v === -want || v === null);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (json) emit({ t: 'depth', depth: d, nodes: totalNodes(), sec: Number(sec), result: winIdx >= 0 ? `P${mover}` : allLose ? `P${mover === 1 ? 2 : 1}` : null });
    if (winIdx >= 0) {
      best = rootActs[winIdx];
      console.log(`\n✅ РЕШЕНО за ${sec} с: игрок ${mover} выигрывает форсированно, не более чем за ${d} действий.`);
      console.log(`   Лучшее первое действие: ${JSON.stringify(best)}`);
      finish(0);
    }
    if (allLose) {
      console.log(`\n✅ РЕШЕНО за ${sec} с: игрок ${mover === 1 ? 2 : 1} выигрывает при любой игре соперника (≤ ${d} действий).`);
      finish(0);
    }
    console.log(`\nГлубина ${d}: исход не определён, ${fmt(totalNodes())} узлов, ${sec} с — углубляюсь`);
  }
  console.log(`Достигнут предел --max-depth ${maxDepth}: исход не определён.`);
  finish(0);
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' млрд';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' млн';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' тыс';
  return String(Math.round(n));
}

/** A small endgame with a real forced result, to watch the solver finish. */
function demoPosition() {
  const u = (id, player, type, row, col) => {
    const T = rules.UNIT_TYPES[type];
    return {
      id, player, type, row, col, maxHp: T.hp, hp: T.hp, startArmor: T.armor, armor: T.armor, maxArmor: T.armor,
      damage: T.damage, maxMoves: T.moves, movesLeft: T.moves, done: false, activated: false,
      visualRow: null, visualCol: null, dying: false, deathProgress: 0, weapon: null, armorGear: null,
      backpack: rules.emptyBackpack(), wardedBy: null,
    };
  };
  // P2's castle (rows 16-19, cols 8-11) has one full-health knight inside.
  // P1 has a cavalry and a samurai at the gate: can they kill the defender
  // AND get a unit inside within this one turn? The solver proves it.
  return createInitialState({
    mode: 'pvp',
    seed: 1,
    units: [
      u(1, 1, 'cavalry', 15, 9),
      u(2, 1, 'samurai', 16, 10),
      u(3, 1, 'knight', 1, 9),
      u(4, 2, 'knight', 17, 9),
      u(5, 2, 'archer', 5, 15),
    ],
  });
}
