#!/usr/bin/env node
/**
 * Difficulty ladder — round-robin between AI levels on the real engine
 * (createMatchSetup + applyAction), all cores in parallel. Checks that every
 * level matches its name: each one must beat every weaker one, and
 * "impossible" must not lose at all.
 *
 *   node scripts/ladder.mjs [--games 8] [--max-turns 100] [--players random,easy,medium,hard,impossible]
 *
 * A player is `random`, `greedy`, or a BEAM_DIFFICULTY key. Every pair plays
 * `games` games on seeds 1..games, sides swapped every other game, so both
 * sides see the same maps. Exit code 1 if the ladder is not strict.
 */
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const rules = await import(new URL('../dist/index.js', import.meta.url).href);
const {
  applyAction, createInitialState, createMatchSetup, endTurn, greedyTurn, generateActionsForPlayer,
  planTurn, planTurnWithReply, toBeamOptions, toReplyOptions, BEAM_DIFFICULTY, mulberry32, unitValue, planTurnFor,
} = rules;

/** Ad-hoc configs to try before promoting one into BEAM_DIFFICULTY. */
const EXTRA = JSON.parse(process.env.LADDER_EXTRA ?? '{}');

/** Army value gap (≈ half a unit) that decides a game still running at the turn limit. */
const ADJUDICATE_GAP = 5000;

function randomTurn(state, me, rng) {
  for (let i = 0; i < 12 && state.winner === null; i++) {
    const acts = generateActionsForPlayer(state, me);
    if (!acts.length || rng.next() < 0.15) break;
    const r = applyAction(state, acts[Math.floor(rng.next() * acts.length)], rng);
    if (r.ok) state = r.value;
  }
  return state;
}

function playTurn(name, state, me, execRng, searchSeed) {
  if (name === 'random') return randomTurn(state, me, execRng);
  if (name === 'greedy') return greedyTurn(state, me, execRng);
  const actions = planTurnFor(state, me, BEAM_DIFFICULTY[name] ?? EXTRA[name], searchSeed);
  for (const a of actions) {
    const r = applyAction(state, a, execRng);
    if (r.ok) state = r.value;
    if (state.winner !== null) break;
  }
  return state;
}

/** One game; returns { winner: 'a' | 'b' | null, turns, ms: {a,b} }. */
function playGame(a, b, seed, aSide, maxTurns) {
  let state = createInitialState({ mode: 'pvp', seed, ...createMatchSetup(seed) });
  const execRng = mulberry32(seed, 0);
  const ms = { a: 0, b: 0 };
  const army = (p) => state.units.filter((u) => u.player === p && u.hp > 0).reduce((s, u) => s + unitValue(u), 0);
  const gaps = []; // aSide's army lead after each half-turn
  let turns = 0;
  while (state.winner === null && turns < maxTurns) {
    const me = state.currentPlayer;
    const who = me === aSide ? 'a' : 'b';
    const t0 = Date.now();
    state = playTurn(who === 'a' ? a : b, state, me, execRng, seed * 1000 + turns);
    ms[who] += Date.now() - t0;
    gaps.push(army(aSide) - army(aSide === 1 ? 2 : 1));
    if (state.winner !== null) break;
    state = endTurn(state);
    turns++;
  }
  let winner = state.winner === null ? null : state.winner === aSide ? 'a' : 'b';
  let points = false;
  if (winner === null) {
    // Turn limit: adjudicate on army value, so a standoff where one side is
    // clearly ahead still counts (bots that never cross a defended bridge
    // otherwise draw every game and the ladder measures nothing).
    // Mean of the last two half-turns: right after P2's final move P1 never
    // gets its reply, so the bare last snapshot favoured P2 (measured: P2
    // "won" 22 of 24 games between strong bots that way).
    const last = gaps.slice(-2);
    const gap = last.reduce((x, y) => x + y, 0) / Math.max(1, last.length);
    if (Math.abs(gap) >= ADJUDICATE_GAP) {
      winner = gap > 0 ? 'a' : 'b';
      points = true;
    }
  }
  return { winner, points, turns, ms, side: winner === null ? 0 : winner === 'a' ? aSide : aSide === 1 ? 2 : 1 };
}

if (!isMainThread) {
  parentPort.on('message', (job) => {
    parentPort.postMessage({ job, res: playGame(job.a, job.b, job.seed, job.aSide, job.maxTurns) });
  });
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i < 0 ? d : args[i + 1];
  };
  const games = Number(opt('games', 8));
  const maxTurns = Number(opt('max-turns', 100));
  const players = opt('players', 'random,easy,medium,hard,impossible').split(',');
  const jobs = [];
  for (let i = 0; i < players.length; i++)
    for (let j = i + 1; j < players.length; j++)
      for (let g = 0; g < games; g++)
        // Each map twice, sides swapped — map/side luck cancels out per pair.
        jobs.push({ a: players[j], b: players[i], seed: Math.floor(g / 2) + 1, aSide: g % 2 ? 2 : 1, maxTurns });
  // --log FILE: every finished game is appended there, and a rerun with the
  // same file skips games already played — a long ladder survives restarts.
  const logFile = opt('log', null);
  const jobKey = (j) => `${j.a}|${j.b}|${j.seed}|${j.aSide}|${j.maxTurns}`;
  const logged = new Map();
  if (logFile && existsSync(logFile)) {
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      logged.set(jobKey(e.job), e.res);
    }
  }
  // Longest pairings first so the pool doesn't idle on one straggler at the end.
  const cost = (p) => {
    const c = BEAM_DIFFICULTY[p] ?? EXTRA[p];
    return !c ? 0 : c.rollout ? c.rollout.candidates * c.rollout.turns * 10 : c.beamWidth * (c.reply ? 10 : 1);
  };
  jobs.sort((x, y) => cost(y.a) + cost(y.b) - (cost(x.a) + cost(x.b)));

  const table = {}; // table[x][y] = {w, l, d}
  const time = {}; // per-player total ms / turns
  let pointWins = 0;
  const sideWins = [0, 0, 0];
  for (const p of players) {
    table[p] = {};
    time[p] = { ms: 0, turns: 0 };
    for (const q of players) table[p][q] = { w: 0, l: 0, d: 0 };
  }
  const t0 = Date.now();
  let done = 0;
  const record = (job, res) => {
    const A = table[job.a][job.b];
    const B = table[job.b][job.a];
    if (res.winner === 'a') (A.w++, B.l++);
    else if (res.winner === 'b') (A.l++, B.w++);
    else (A.d++, B.d++);
    if (res.points) pointWins++;
    sideWins[res.side]++;
    time[job.a].ms += res.ms.a;
    time[job.b].ms += res.ms.b;
    time[job.a].turns += Math.ceil(res.turns / 2);
    time[job.b].turns += Math.floor(res.turns / 2);
  };
  const pending = [];
  for (const j of jobs) {
    const r = logged.get(jobKey(j));
    if (r) record(j, r);
    else pending.push(j);
  }
  jobs.length = 0;
  jobs.push(...pending);
  if (logged.size) process.stderr.write(`resumed: ${logged.size} games from ${logFile}\n`);
  await new Promise((resolve) => {
    if (jobs.length === 0) return resolve(); // everything came from the log
    let next = 0;
    const n = Math.min(availableParallelism(), jobs.length);
    for (let k = 0; k < n; k++) {
      const w = new Worker(fileURLToPath(import.meta.url));
      const feed = () => (next < jobs.length ? w.postMessage(jobs[next++]) : w.terminate());
      w.on('message', ({ job, res }) => {
        record(job, res);
        if (logFile) appendFileSync(logFile, JSON.stringify({ job, res }) + '\n');
        done++;
        process.stderr.write(`\r${done}/${jobs.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        if (done === jobs.length) resolve();
        feed();
      });
      feed();
    }
  });
  console.log(`\n\nrow vs column: wins-losses-draws (${games} games per pair, max ${maxTurns} turns; ${pointWins} decided on army value at the limit)\n`);
  const pad = (s, n = 12) => String(s).padEnd(n);
  console.log(pad('') + players.map((p) => pad(p)).join(''));
  for (const p of players)
    console.log(pad(p) + players.map((q) => pad(p === q ? '—' : `${table[p][q].w}-${table[p][q].l}-${table[p][q].d}`)).join(''));
  console.log(`\nwins by side: P1 ${sideWins[1]}, P2 ${sideWins[2]}, draws ${sideWins[0]}`);
  console.log('\nms per turn: ' + players.map((p) => `${p} ${(time[p].ms / Math.max(1, time[p].turns)).toFixed(0)}`).join(', '));

  // Strict ladder: each level beats every weaker one in a clear majority of
  // games and never loses more than it wins; the top one never loses.
  let ok = true;
  for (let i = 0; i < players.length; i++)
    for (let j = 0; j < i; j++) {
      const r = table[players[i]][players[j]];
      if (r.w <= r.l || r.w < games / 2) {
        ok = false;
        console.log(`✗ ${players[i]} does not clearly beat ${players[j]}: ${r.w}-${r.l}-${r.d}`);
      }
    }
  const top = players[players.length - 1];
  const topLosses = players.slice(0, -1).reduce((s, q) => s + table[top][q].l, 0);
  if (topLosses > 0) {
    ok = false;
    console.log(`✗ ${top} lost ${topLosses} game(s)`);
  }
  console.log(ok ? '\n✓ strict ladder' : '\n✗ ladder broken');
  process.exit(ok ? 0 : 1);
}
