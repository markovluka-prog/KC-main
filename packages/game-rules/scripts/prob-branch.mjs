#!/usr/bin/env node
/**
 * Build ONE game branch, start → end, that keeps a chosen player's win
 * probability as close as possible to a target value.
 *
 * Win probability of a position = the share of the game tree's branches
 * below it that end in that player's win. The exact share is uncomputable
 * (the tree is effectively infinite), so it is estimated the standard way:
 * sample branches uniformly at random (each step picks a legal action with
 * equal chance), play each to the end, count the wins (Monte Carlo).
 *
 * At every step each legal action is scored by that estimate, and the action
 * whose probability is closest to the target is played. Repeat until the
 * game ends. All CPU cores sample in parallel.
 *
 * Prints JSON lines for branch_by_probability.py:
 *   {"t":"start",...} {"t":"step",step,action,prob,best,candidates,sec,...} {"t":"end",...}
 *
 *   node prob-branch.mjs --target 0.7 --player 1 [--samples 24] [--max-len 3000] [--seed 1]
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const rules = await import(new URL('../dist/index.js', import.meta.url).href);
const { applyAction, createInitialState, createMatchSetup, generateActionsForPlayer, mulberry32 } = rules;
const RNG = mulberry32(1);
const END = { kind: 'end-turn' };
const actionsOf = (s) => {
  const out = generateActionsForPlayer(s, s.currentPlayer);
  out.push(END);
  return out;
};

/** One uniformly random branch from s to the end (or maxLen actions). Returns winner 1/2 or 0. */
function playout(s, rand, maxLen) {
  for (let i = 0; i < maxLen; i++) {
    if (s.winner !== null) return s.winner;
    const acts = actionsOf(s);
    for (let tries = 0; tries < 4; tries++) {
      const r = applyAction(s, acts[Math.floor(rand() * acts.length)], RNG);
      if (r.ok) {
        s = r.value;
        break;
      }
    }
  }
  return s.winner ?? 0;
}

if (!isMainThread) {
  let seed = workerData.seed;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  parentPort.on('message', ({ id, state, samples, maxLen, player }) => {
    let wins = 0, ended = 0, actions = 0;
    for (let k = 0; k < samples; k++) {
      const w = playout(state, rand, maxLen);
      if (w) ended++;
      if (w === player) wins++;
      actions += maxLen; // upper bound, for the speed readout
    }
    parentPort.postMessage({ id, wins, ended, samples });
  });
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i < 0 ? d : args[i + 1];
  };
  const target = Number(opt('target', 0.5));
  const player = Number(opt('player', 1));
  const samples = Number(opt('samples', 12));
  // Random branches from the start end after ~7 700 actions on average; at
  // 20 000 almost all of them reach a win.
  const maxLen = Number(opt('max-len', 20000));
  // Candidate actions scored per step (a random subset when there are more).
  const nCand = Number(opt('candidates', 8));
  const seed = Number(opt('seed', 1));
  const nW = Number(opt('workers', availableParallelism()));
  const emit = (o) => console.log(JSON.stringify(o));

  const workers = Array.from({ length: nW }, (_, i) => new Worker(fileURLToPath(import.meta.url), { workerData: { seed: 1000 + i * 7919 } }));
  let nextId = 0;
  const pending = new Map();
  for (const w of workers) w.on('message', (m) => pending.get(m.id)(m));
  const queue = [];
  const idle = [...workers];
  const runNext = () => {
    while (idle.length && queue.length) {
      const job = queue.shift();
      const w = idle.shift();
      pending.set(job.id, (m) => {
        pending.delete(job.id);
        idle.push(w);
        job.resolve(m);
        runNext();
      });
      w.postMessage(job.msg);
    }
  };
  /** Estimated win probability of `state` for `player`, sampled across all cores. */
  const estimate = (state) => {
    const per = Math.ceil(samples / nW);
    const parts = [];
    for (let k = 0; k < samples; k += per) {
      parts.push(
        new Promise((resolve) => {
          queue.push({ id: nextId++, resolve, msg: { id: nextId - 1, state, samples: Math.min(per, samples - k), maxLen, player } });
        }),
      );
    }
    runNext();
    return Promise.all(parts).then((rs) => {
      const wins = rs.reduce((a, r) => a + r.wins, 0);
      const n = rs.reduce((a, r) => a + r.samples, 0);
      return wins / n;
    });
  };

  let s = createInitialState({ mode: 'pvp', seed, ...createMatchSetup(seed) });
  const t0 = Date.now();
  emit({ t: 'start', target, player, samples, maxLen, workers: nW });
  const startProb = await estimate(s);
  emit({ t: 'startProb', prob: startProb });

  const branch = [];
  for (let step = 1; s.winner === null; step++) {
    const acts = actionsOf(s);
    let kids = [];
    for (const a of acts) {
      const r = applyAction(s, a, RNG);
      if (r.ok) kids.push({ a, s: r.value });
    }
    // An immediately decisive action is always considered; the rest are a
    // random subset (scoring all ~30-70 actions every step would take days).
    const decisive = kids.filter((k) => k.s.winner !== null);
    const rest = kids.filter((k) => k.s.winner === null);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    kids = decisive.concat(rest.slice(0, Math.max(1, nCand - decisive.length)));
    // An immediately finished child has a known probability (1 or 0).
    const probs = await Promise.all(
      kids.map((k) => (k.s.winner !== null ? Promise.resolve(k.s.winner === player ? 1 : 0) : estimate(k.s))),
    );
    let bi = 0;
    for (let i = 1; i < kids.length; i++) if (Math.abs(probs[i] - target) < Math.abs(probs[bi] - target)) bi = i;
    s = kids[bi].s;
    branch.push({ action: kids[bi].a, prob: probs[bi] });
    emit({
      t: 'step', step, action: kids[bi].a, prob: probs[bi], mover: kids[bi].s.currentPlayer,
      candidates: kids.length, min: Math.min(...probs), max: Math.max(...probs), sec: (Date.now() - t0) / 1000,
    });
  }
  emit({ t: 'end', winner: s.winner, length: branch.length, sec: (Date.now() - t0) / 1000, branch });
  process.exit(0);
}
