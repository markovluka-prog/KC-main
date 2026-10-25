#!/usr/bin/env node
/**
 * "Depth = victory": walk EVERY branch from the starting position all the way
 * down until someone wins — no depth limit — using the real rules engine.
 *
 * Depth-first, on all CPU cores (root actions are spread across workers).
 * A branch ends when:
 *   - someone wins (counted per winner), or
 *   - its position already occurred earlier on the SAME path: the branch has
 *     looped (units walking back and forth) and could never end — it is cut
 *     and counted as a cycle. Without this the search would spin forever in
 *     the first loop it meets.
 *
 * Prints one JSON line per second for run_to_win.py:
 *   {"t":"progress","nodes","wins1","wins2","cycles","depth","maxDepth","sec","rootDone","rootTotal"}
 *   {"t":"firstWin","winner","length","line":[...actions]}
 *   {"t":"done", ...totals}
 *
 * Usage (from packages/game-rules, after `pnpm build`):
 *   node scripts/dfs-to-win.mjs [--seed N] [--workers N]
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const rules = await import(new URL('../dist/index.js', import.meta.url).href);
const { applyAction, createInitialState, createMatchSetup, generateActionsForPlayer, mulberry32 } = rules;
const RNG = mulberry32(1);
const END = { kind: 'end-turn' };

function actionsOf(s) {
  const out = generateActionsForPlayer(s, s.currentPlayer);
  out.push(END);
  return out;
}

/**
 * 64-bit position hash (two 32-bit halves) over everything the rules depend
 * on. A string key was the single biggest cost per node; this is several
 * times cheaper. Collision odds at 10^9 positions are ~10^-10.
 */
let H1 = 0, H2 = 0;
let h1 = 0, h2 = 0;
// Module-level mixer (no closure allocated per hash() call).
function mix(x) {
  h1 = Math.imul(h1 ^ x, 0x01000193);
  h2 = Math.imul(h2 ^ (x + 0x9e3779b9), 0x85ebca6b);
  h2 ^= h2 >>> 15;
}
function hash(s) {
  h1 = 0x811c9dc5 ^ s.currentPlayer;
  h2 = 0x01000193 ^ (s.activatedCount * 31 + 7);
  for (const u of s.units) {
    mix(u.id);
    mix(u.row * 32 + u.col);
    mix(u.hp * 64 + u.armor * 4 + (u.done ? 2 : 0) + (u.activated ? 1 : 0));
    mix(u.maxArmor * 64 + u.damage);
    mix(u.movesLeft * 256 + (u.energy ?? 0));
    mix(u.wardedBy ?? 0);
    const b = u.backpack;
    mix(b['Металл'] | (b['Амулет'] << 4) | (b['Рубин'] << 8) | (b['Дерево'] << 12) | (b['Стрелы'] << 16));
    mix(u.weapon ? u.weapon.name.length * 7 + u.weapon.amount : 0);
    mix(u.armorGear ? u.armorGear.name.length * 7 + u.armorGear.amount : 0);
  }
  for (const t of s.terrain) if (t.type === 'rock' || t.type === 'bridge') mix(t.row * 32 + t.col + (t.type === 'rock' ? 4096 : 8192));
  for (const t of s.towers) mix(t.row * 32 + t.col + 16384);
  for (const c of s.constructions) mix(c.row * 32 + c.col + c.progress * 1024 + 32768);
  for (const d of s.droppedBackpacks) mix(d.row * 32 + d.col + 50000);
  mix(s.hiddenPickups.length + 70000);
  H1 = (h1 | 1) >>> 0; // never 0: 0 marks an empty slot
  H2 = h2 >>> 0;
}

/**
 * Shared seen-table: every core reads and writes the same open-addressing hash
 * set (SharedArrayBuffer + Atomics), so a position explored by ANY thread is
 * never explored again — the search covers each distinct position once
 * instead of once per path that reaches it.
 */
let TABLE, VAL, MASK;
let SLOT = -1; // slot of the last lookup (-1: table neighbourhood full)
/** true if the position (H1,H2) was already claimed; sets SLOT either way. */
function seenOrInsert() {
  let i = (H1 ^ Math.imul(H2, 0x9e3779b1)) & MASK;
  for (let probe = 0; probe < 64; probe++) {
    const at = i * 2;
    const cur = Atomics.load(TABLE, at);
    if (cur === 0) {
      if (Atomics.compareExchange(TABLE, at, 0, H1) === 0) {
        Atomics.store(TABLE, at + 1, H2);
        SLOT = i;
        return false; // newly claimed
      }
      continue; // lost a race for this slot — re-read it
    }
    if (cur === H1 && Atomics.load(TABLE, at + 1) === H2) {
      SLOT = i;
      return true;
    }
    i = (i + 1) & MASK;
  }
  SLOT = -1;
  return false; // neighbourhood full: treat as unseen (correct, just slower)
}

/**
 * Move ordering — finish branches sooner and find wins earlier: attacks and
 * mage strikes first, then moves that step toward the enemy castle, the rest,
 * and ending the turn last.
 */
function ordered(s, acts) {
  const goal = s.currentPlayer === 1 ? 17 : 2;
  const units = s.units;
  const rowOf = (id) => {
    for (const u of units) if (u.id === id) return u.row;
    return goal;
  };
  const a1 = [], a2 = [], a3 = [], a4 = [];
  for (const a of acts) {
    if (a.kind === 'attack' || a.kind === 'mage-attack') a1.push(a);
    else if (a.kind === 'move') (Math.abs(a.row - goal) < Math.abs(rowOf(a.unitId) - goal) ? a2 : a3).push(a);
    else if (a.kind === 'end-turn') a4.push(a);
    else a3.push(a);
  }
  return a1.concat(a2, a3, a4);
}

if (!isMainThread) {
  const root = workerData.root;
  TABLE = new Int32Array(workerData.table);
  VAL = new Int8Array(workerData.values); // per slot: 0 unknown, 1/2 = proven winner
  MASK = TABLE.length / 2 - 1;
  const rootActs = actionsOf(root);
  let nodes = 0, wins1 = 0, wins2 = 0, cycles = 0, merged = 0, depth = 0, maxDepth = 0, skipped = 0;
  let reportedFirst = false;
  const report = () =>
    parentPort.postMessage({ type: 'stats', nodes, wins1, wins2, cycles, merged, depth, maxDepth, skipped });

  parentPort.on('message', ({ index }) => {
    // Value of this root action: 1/2 = proven winner, 0 = not proven.
    let rootValue = 0;
    const first = applyAction(root, rootActs[index], RNG);
    if (first.ok) {
      hash(root);
      const onPath = new Set([H1 * 2097152 + (H2 & 0x1fffff)]);
      const stack = [];
      const pathActions = [rootActs[index]];
      // Paths get very long (hundreds of thousands of actions), so only the
      // top KEEP frames hold their action list; deeper ones drop it and
      // regenerate it (deterministically, same order) when the search climbs
      // back to them. Same result, a fraction of the memory.
      const KEEP = 64;
      const push = (s) => {
        stack.push({ s, acts: null, i: 0, k: 0, slot: -1, expanded: false, unknown: false });
        const old = stack.length - 1 - KEEP;
        if (old >= 0 && stack[old].acts) stack[old].acts = 'dropped';
      };
      /**
       * The top frame is finished with value v (1/2 = proven winner, 0 = not
       * proven). Proof cut-off: if that makes its parent's mover a proven
       * winner, the parent is finished too — its remaining actions cannot
       * change the result and are never generated. Unknowns (loops, positions
       * still open elsewhere) only mark the parent as "not provably lost".
       */
      const settle = (v) => {
        for (;;) {
          const f = stack.pop();
          pathActions.pop();
          if (f.expanded) {
            onPath.delete(f.k);
            if (v && f.slot >= 0) Atomics.store(VAL, f.slot, v);
          }
          const p = stack[stack.length - 1];
          if (!p) {
            rootValue = v;
            return;
          }
          if (v !== 0 && v === p.s.currentPlayer) {
            skipped += p.acts && p.acts !== 'dropped' ? p.acts.length - p.i : 0;
            continue; // parent proven won: settle it as well
          }
          if (v === 0) p.unknown = true;
          return;
        }
      };
      push(first.value);
      while (stack.length) {
        const f = stack[stack.length - 1];
        if (f.acts === null) {
          nodes++;
          if ((nodes & 0xffff) === 0) {
            depth = stack.length;
            report();
          }
          if (f.s.winner !== null) {
            if (f.s.winner === 1) wins1++;
            else wins2++;
            if (!reportedFirst) {
              reportedFirst = true;
              parentPort.postMessage({ type: 'firstWin', winner: f.s.winner, length: stack.length, line: pathActions.slice() });
            }
            settle(f.s.winner);
            continue;
          }
          hash(f.s);
          f.k = H1 * 2097152 + (H2 & 0x1fffff);
          if (onPath.has(f.k)) {
            cycles++; // repeated on this path: an endless loop, cut it
            settle(0);
            continue;
          }
          if (seenOrInsert()) {
            merged++; // already explored elsewhere: reuse its proven value, if any
            settle(Atomics.load(VAL, SLOT));
            continue;
          }
          f.slot = SLOT;
          f.expanded = true;
          onPath.add(f.k);
          f.acts = ordered(f.s, actionsOf(f.s));
          if (stack.length > maxDepth) maxDepth = stack.length;
        }
        if (f.acts === 'dropped') f.acts = ordered(f.s, actionsOf(f.s));
        if (f.i >= f.acts.length) {
          // Every action tried and none wins: lost if all were proven losses.
          settle(f.unknown ? 0 : f.s.currentPlayer === 1 ? 2 : 1);
          continue;
        }
        const a = f.acts[f.i++];
        const r = applyAction(f.s, a, RNG);
        if (r.ok) {
          pathActions.push(a);
          push(r.value);
        }
      }
    } else rootValue = -1; // not a legal action here
    report();
    parentPort.postMessage({ type: 'rootDone', index, value: rootValue });
  });
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i < 0 ? d : args[i + 1];
  };
  const seed = Number(opt('seed', 1));
  const workersN = Number(opt('workers', availableParallelism()));
  // Shared seen-table: 2^log2 slots × 8 bytes (default 2^27 = 1 GiB).
  const log2 = Number(opt('table-log2', 27));
  const table = new SharedArrayBuffer(8 * 2 ** log2);
  const values = new SharedArrayBuffer(2 ** log2);
  const root = opt('position', null)
    ? JSON.parse(readFileSync(opt('position'), 'utf8'))
    : createInitialState({ mode: 'pvp', seed, ...createMatchSetup(seed) });
  const rootActs = actionsOf(root);
  const emit = (o) => console.log(JSON.stringify(o));
  emit({ t: 'start', seed, workers: workersN, rootTotal: rootActs.length, units: root.units.length });

  const stats = Array.from({ length: workersN }, () => ({ nodes: 0, wins1: 0, wins2: 0, cycles: 0, merged: 0, depth: 0, maxDepth: 0, skipped: 0 }));
  let next = 0;
  let rootDone = 0;
  const rootValues = new Array(rootActs.length);
  let firstWinSent = false;
  const t0 = Date.now();
  const totals = () => {
    const t = { nodes: 0, wins1: 0, wins2: 0, cycles: 0, merged: 0, depth: 0, maxDepth: 0, skipped: 0 };
    for (const s of stats) {
      t.nodes += s.nodes;
      t.wins1 += s.wins1;
      t.wins2 += s.wins2;
      t.cycles += s.cycles;
      t.merged += s.merged;
      t.skipped += s.skipped;
      t.depth = Math.max(t.depth, s.depth);
      t.maxDepth = Math.max(t.maxDepth, s.maxDepth);
    }
    return t;
  };
  const workers = [];
  for (let w = 0; w < workersN; w++) {
    const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { root, table, values } });
    wk.on('message', (m) => {
      if (m.type === 'stats') Object.assign(stats[w], m);
      else if (m.type === 'firstWin' && !firstWinSent) {
        firstWinSent = true;
        emit({ t: 'firstWin', winner: m.winner, length: m.length, line: m.line });
      } else if (m.type === 'rootDone') {
        rootDone++;
        rootValues[m.index] = m.value;
        const mover = root.currentPlayer;
        const legal = rootValues.filter((v) => v !== -1 && v !== undefined);
        if (m.value === mover) {
          emit({ t: 'solved', winner: mover, firstAction: rootActs[m.index], ...totals(), sec: (Date.now() - t0) / 1000 });
          process.exit(0);
        }
        if (rootDone === rootActs.length && legal.length && legal.every((v) => v === (mover === 1 ? 2 : 1))) {
          emit({ t: 'solved', winner: mover === 1 ? 2 : 1, ...totals(), sec: (Date.now() - t0) / 1000 });
          process.exit(0);
        }
        if (next < rootActs.length) wk.postMessage({ index: next++ });
        if (rootDone === rootActs.length) {
          emit({ t: 'done', ...totals(), sec: (Date.now() - t0) / 1000 });
          process.exit(0);
        }
      }
    });
    workers.push(wk);
    if (next < rootActs.length) wk.postMessage({ index: next++ });
  }
  setInterval(() => {
    emit({ t: 'progress', ...totals(), sec: (Date.now() - t0) / 1000, rootDone, rootTotal: rootActs.length });
  }, 1000);
  process.on('SIGINT', () => {
    emit({ t: 'done', ...totals(), sec: (Date.now() - t0) / 1000, stopped: true });
    process.exit(0);
  });
}
