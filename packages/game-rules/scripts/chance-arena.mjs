#!/usr/bin/env node
/**
 * Arena for the "Свой шанс" AI: real games on the real engine, no browser.
 * P1 = greedy baseline (greedyTurn: best-evaluated action each step),
 * P2 = the chance policy at target 100% in a chosen variant. Games run to a
 * win or MAX_TURNS full turns, then are adjudicated by the evaluation.
 *
 *   node scripts/chance-arena.mjs --variant old|new --games 6 --seed 1
 * Prints one JSON line per game and a summary.
 */
const r = await import(new URL('../dist/index.js', import.meta.url).href);
const { applyAction, createInitialState, createMatchSetup, generateActionsForPlayer, evaluate, greedyTurn, mulberry32, endTurn } = r;

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1];
};
const variant = opt('variant', 'new');
const games = Number(opt('games', 6));
const seed0 = Number(opt('seed', 1));
const MAX_TURNS = Number(opt('turns', 30));
const RNG = mulberry32(1);
const END = { kind: 'end-turn' };

let rs = 12345;
const rand = () => {
  rs = (rs + 0x6d2b79f5) | 0;
  let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const EVAL_BIAS_P2 = 10000, EVAL_SCALE = 40000;
const evalProb = (s, p) => {
  let d = evaluate(s, p) - evaluate(s, p === 1 ? 2 : 1);
  d += p === 2 ? -EVAL_BIAS_P2 : EVAL_BIAS_P2;
  return 1 / (1 + Math.exp(-d / EVAL_SCALE));
};
const isAttack = (a) => a.kind === 'attack' || a.kind === 'mage-attack';

/** Rollout policy. old: uniform random. new: takes an attack when one exists (70%). */
function rolloutAction(acts) {
  if (variant === 'new') {
    const atk = acts.filter(isAttack);
    if (atk.length && rand() < 0.7) return atk[Math.floor(rand() * atk.length)];
  }
  return acts[Math.floor(rand() * acts.length)];
}

function playout(s, maxLen) {
  for (let i = 0; i < maxLen && s.winner === null; i++) {
    const acts = generateActionsForPlayer(s, s.currentPlayer);
    acts.push(END);
    for (let k = 0; k < 4; k++) {
      const x = applyAction(s, rolloutAction(acts), RNG);
      if (x.ok) {
        s = x.value;
        break;
      }
    }
  }
  return s;
}

const MAPPABLE = new Set(['move', 'attack', 'craft', 'craft-armor', 'castle-heal']);

/** One action of the chance policy (target 100%) for `me`. */
function chanceAction(state, me) {
  const kids = [];
  const own = generateActionsForPlayer(state, me).filter((a) => MAPPABLE.has(a.kind));
  // Ending the turn is only an option once nothing else is left: offered as a
  // candidate it often LOOKED best and the bot gave away most of its turn.
  for (const a of own.length ? own : [END]) {
    const x = applyAction(state, a, RNG);
    if (!x.ok) continue;
    if (x.value.winner === me) return a;
    kids.push({ a, s: x.value, prior: x.value.winner ? 0 : evalProb(x.value, me) });
  }
  if (kids.length === 1) return kids[0].a;
  if (variant === 'eval') {
    // Chance = calibrated evaluation of the position right after the action.
    kids.sort((x, y) => y.prior - x.prior);
    return kids[0].a;
  }
  if (variant === 'eval2') {
    // Look one exchange ahead: finish my turn greedily, let the opponent
    // answer with its best (greedy) turn, THEN evaluate. Only the top
    // candidates by the 1-ply evaluation get this deeper look.
    kids.sort((x, y) => y.prior - x.prior);
    const top = kids.slice(0, 6);
    for (const k of kids) if (isAttack(k.a) && !top.includes(k)) top.push(k);
    let best = top[0], bestP = -1;
    for (const k of top) {
      let t = k.s;
      if (t.winner === null && t.currentPlayer === me && k.a.kind !== 'end-turn') t = greedyTurn(t, me, mulberry32(1));
      if (t.winner === null && t.currentPlayer === me) t = endTurn(t);
      if (t.winner === null) t = greedyTurn(t, me === 1 ? 2 : 1, mulberry32(2));
      const p = t.winner === me ? 1 : t.winner ? 0 : evalProb(t, me);
      if (p > bestP) { bestP = p; best = k; }
    }
    return best.a;
  }
  let pick;
  if (variant === 'old') {
    for (let i = kids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [kids[i], kids[j]] = [kids[j], kids[i]];
    }
    pick = kids.slice(0, 10);
  } else {
    // new: rank every candidate by the evaluation of the position it leads to
    // and keep the best 8 — attacks and the end of turn always stay in.
    kids.sort((x, y) => y.prior - x.prior);
    const top = kids.slice(0, 8);
    for (const k of kids) if ((isAttack(k.a) || k.a.kind === 'end-turn') && !top.includes(k)) top.push(k);
    pick = top;
  }
  const wins = new Array(pick.length).fill(0), seen = new Array(pick.length).fill(0);
  const prob = (i) => wins[i] / Math.max(1, seen[i]);
  let alive = pick.map((_, i) => i), per = 2;
  const rounds = Math.ceil(Math.log2(alive.length));
  for (let round = 0; round < rounds && alive.length > 1; round++) {
    for (const i of alive) {
      for (let k = 0; k < per; k++) {
        const end = playout(pick[i].s, 200);
        wins[i] += end.winner === null ? evalProb(end, me) : end.winner === me ? 1 : 0;
        seen[i]++;
      }
    }
    alive.sort((a, b) => prob(b) - prob(a)); // target 100%: highest first
    alive = alive.slice(0, Math.ceil(alive.length / 2));
    per *= 2;
  }
  return pick[alive[0]].a;
}

function chanceTurn(s, me) {
  for (let i = 0; i < 40 && s.winner === null && s.currentPlayer === me; i++) {
    const a = chanceAction(s, me);
    const x = applyAction(s, a, RNG);
    if (!x.ok) return endTurn(s);
    s = x.value;
    if (a.kind === 'end-turn') return s;
  }
  return s.winner === null && s.currentPlayer === me ? endTurn(s) : s;
}

let w2 = 0, w1 = 0, adj2 = 0;
const t0 = Date.now();
for (let g = 0; g < games; g++) {
  const seed = seed0 + g;
  rs = seed * 7919;
  let s = createInitialState({ mode: 'pvp', seed, ...createMatchSetup(seed) });
  let turn = 0;
  for (; turn < MAX_TURNS * 2 && s.winner === null; turn++) {
    if (s.currentPlayer === 1) s = endTurn(greedyTurn(s, 1, mulberry32(seed + turn)));
    else s = chanceTurn(s, 2);
  }
  const p2 = s.winner === 2 ? 1 : s.winner === 1 ? 0 : evalProb(s, 2);
  if (s.winner === 2) w2++;
  else if (s.winner === 1) w1++;
  adj2 += p2;
  const units1 = s.units.filter((u) => u.player === 1).length, units2 = s.units.filter((u) => u.player === 2).length;
  console.log(JSON.stringify({ game: g, winner: s.winner, turns: turn, chanceAIestimate: +p2.toFixed(2), units: [units1, units2] }));
}
console.log(JSON.stringify({ variant, games, chanceWins: w2, greedyWins: w1, unfinished: games - w1 - w2, avgChanceScore: +(adj2 / games).toFixed(2), sec: (Date.now() - t0) / 1000 }));
