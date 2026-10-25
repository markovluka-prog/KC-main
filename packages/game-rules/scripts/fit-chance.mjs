#!/usr/bin/env node
/**
 * Fit chance-weights.json: the evaluation weights that best predict a
 * position's win probability under uniformly random play (every legal action
 * equally likely — the same policy as chance-worker.ts's playouts).
 *
 *   node fit-chance.mjs gen  --games 20000 --out DIR     training rows: features of
 *        positions sampled along full random games, labelled with who won
 *   node fit-chance.mjs test --positions 300 --playouts 64 --out DIR [--old OLD_DIST]
 *        held-out positions, each labelled with the win share of 64 full playouts;
 *        also stores 16 cut (200-action) playout ends per position, to score the
 *        chance-worker estimator. --old = a dist/ of the previous engine, scored too.
 *   node fit-chance.mjs fit  --out DIR      logistic regression → src/chance-weights.json
 *
 * Model: logit P(P1 wins) = Σ wₖ·(Fₖ(s,P1) − Fₖ(s,P2)) / scale + biasP1/scale,
 * F = evalFeatures(). Ridge-penalised toward ai-weights.json in standardised
 * units (λ picked on a held-out game split), so a feature that random play
 * rarely shows (castle capture, recipes) keeps its hand-set value instead of
 * a noisy fit.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const rules = await import(new URL('../dist/index.js', import.meta.url).href);
const { applyAction, createInitialState, createMatchSetup, endTurn, generateActionsForPlayer, greedyTurn, mulberry32, evalFeatures, FEATURES } = rules;
const NF = FEATURES.length;
const RNG = mulberry32(1);
const END = { kind: 'end-turn' };
const MAX_GAME = 40000;
const CUT_LEN = 200;
const CUTS = 16;

function makeRand(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function step(s, rand) {
  const acts = generateActionsForPlayer(s, s.currentPlayer);
  acts.push(END);
  for (let tries = 0; tries < 4; tries++) {
    const r = applyAction(s, acts[Math.floor(rand() * acts.length)], RNG);
    if (r.ok) return r.value;
  }
  return s;
}

function playout(s, rand, maxLen) {
  for (let i = 0; i < maxLen && s.winner === null; i++) s = step(s, rand);
  return s;
}

const f1 = new Float64Array(NF);
const f2 = new Float64Array(NF);
/** F(s,P1) − F(s,P2) as a plain array. */
function deltaF(s) {
  evalFeatures(s, 1, f1);
  evalFeatures(s, 2, f2);
  const d = new Array(NF);
  for (let i = 0; i < NF; i++) d[i] = f1[i] - f2[i];
  return d;
}

const opt = (args, n, d) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1];
};

// ── worker side ─────────────────────────────────────────────────────────────
if (!isMainThread) {
  const old = workerData.old ? await import(workerData.old + '/evaluate.js') : null;
  const oldDelta = (s) => (old ? old.evaluate(s, 1) - old.evaluate(s, 2) : 0);
  parentPort.on('message', ({ mode, seed }) => {
    const rand = makeRand(seed * 7919 + 13);
    let s = createInitialState({ mode: 'pvp', seed, ...createMatchSetup(seed) });
    if (mode === 'gen' && workerData.policy === 'greedy') {
      // Competent play: greedy vs greedy, a few positions per game at turn
      // starts; label = winner. Undecided games are dropped.
      const rows = [];
      const grng = mulberry32(seed);
      for (let t = 0; t < 150 && s.winner === null; t++) {
        if (rand() < 0.15) rows.push({ g: seed, d: deltaF(s) });
        s = greedyTurn(s, s.currentPlayer, grng);
        if (s.winner !== null) break;
        s = endTurn(s);
      }
      if (s.winner === null) return parentPort.postMessage({ rows: [] });
      parentPort.postMessage({ rows: rows.map((r) => ({ ...r, y: s.winner === 1 ? 1 : 0 })) });
    } else if (mode === 'gen') {
      // Sample ~15 positions per game uniformly along it; label = final winner.
      const rows = [];
      for (let k = 0; k < MAX_GAME && s.winner === null; k++) {
        if (rand() < 1 / 400) rows.push({ g: seed, d: deltaF(s) });
        s = step(s, rand);
      }
      if (s.winner === null) return parentPort.postMessage({ rows: [] });
      parentPort.postMessage({ rows: rows.map((r) => ({ ...r, y: s.winner === 1 ? 1 : 0 })) });
    } else {
      // One position at a random depth of a random game, then 64 full playouts.
      const depth = Math.floor(rand() * 6000);
      s = playout(s, rand, depth);
      if (s.winner !== null) return parentPort.postMessage({ row: null });
      let wins = 0;
      let ended = 0;
      for (let k = 0; k < workerData.playouts; k++) {
        const e = playout(s, rand, MAX_GAME);
        if (e.winner === null) continue;
        ended++;
        if (e.winner === 1) wins++;
      }
      const cuts = [];
      for (let k = 0; k < CUTS; k++) {
        const e = playout(s, rand, CUT_LEN);
        cuts.push(e.winner !== null ? { w: e.winner } : { d: deltaF(e), od: oldDelta(e) });
      }
      parentPort.postMessage({ row: { share: ended ? wins / ended : null, d: deltaF(s), od: oldDelta(s), cuts } });
    }
  });
}

// ── main side ───────────────────────────────────────────────────────────────
async function runPool(mode, total, extra, onResult) {
  const n = availableParallelism();
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    for (let w = 0; w < n; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: extra });
      const feed = () => {
        if (next >= total) return worker.terminate();
        worker.postMessage({ mode, seed: extra.seedBase + next++ });
      };
      worker.on('message', (m) => {
        onResult(m);
        done++;
        if (done % Math.max(1, Math.floor(total / 20)) === 0)
          console.error(`${mode}: ${done}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        if (done >= total) resolve();
        feed();
      });
      feed();
    }
  });
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** Solve A x = b (A symmetric positive definite) by Cholesky. */
function cholSolve(A, b) {
  const n = b.length;
  const L = A.map((r) => r.slice());
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j; k++) L[j][j] -= L[j][k] ** 2;
    L[j][j] = Math.sqrt(Math.max(L[j][j], 1e-12));
    for (let i = j + 1; i < n; i++) {
      for (let k = 0; k < j; k++) L[i][j] -= L[i][k] * L[j][k];
      L[i][j] /= L[j][j];
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/**
 * Ridge logistic regression by Newton's method. X rows are raw ΔF (eval
 * units); params β (weights, eval units) + β0 (intercept, logit units).
 * logit = (Σ βₖ xₖ)/scale + β0. Penalty λ·Σ (sdₖ(βₖ − priorₖ)/scale)².
 */
function fitLogistic(X, y, prior, sd, lambda, scale) {
  const n = NF + 1;
  let beta = [...prior, 0];
  for (let it = 0; it < 30; it++) {
    const g = new Array(n).fill(0);
    const H = Array.from({ length: n }, () => new Array(n).fill(0));
    const x = new Array(n);
    for (let r = 0; r < X.length; r++) {
      const row = X[r];
      let z = beta[NF];
      for (let k = 0; k < NF; k++) {
        x[k] = row[k] / scale;
        z += beta[k] * x[k];
      }
      x[NF] = 1;
      const p = sigmoid(z);
      const e = p - y[r];
      const wgt = Math.max(p * (1 - p), 1e-9);
      for (let i = 0; i < n; i++) {
        if (x[i] === 0) continue;
        g[i] += e * x[i];
        const wi = wgt * x[i];
        for (let j = 0; j <= i; j++) H[i][j] += wi * x[j];
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) H[j][i] = H[i][j];
    for (let k = 0; k < NF; k++) {
      // sd = 0: never varies in the data → pin to the prior.
      const pen = sd[k] > 0 ? lambda * (sd[k] / scale) ** 2 * X.length : 1e6;
      g[k] += 2 * pen * (beta[k] - prior[k]);
      H[k][k] += 2 * pen;
    }
    const delta = cholSolve(H, g);
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      beta[i] -= delta[i];
      maxStep = Math.max(maxStep, Math.abs(delta[i]) / (Math.abs(beta[i]) + 1));
    }
    if (maxStep < 1e-7) break;
  }
  return beta;
}

function logloss(X, y, beta, scale) {
  let L = 0;
  for (let r = 0; r < X.length; r++) {
    let z = beta[NF];
    for (let k = 0; k < NF; k++) z += (beta[k] * X[r][k]) / scale;
    const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(z)));
    L -= y[r] ? Math.log(p) : Math.log(1 - p);
  }
  return L / X.length;
}

function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks.at(-1)] = v;
}
function getPath(obj, path) {
  let o = obj;
  for (const k of path.split('.')) o = o?.[k];
  return typeof o === 'number' ? o : 0;
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const out = opt(args, 'out', '.');
  if (!existsSync(out)) mkdirSync(out, { recursive: true });

  if (mode === 'gen') {
    const games = Number(opt(args, 'games', 20000));
    const file = `${out}/train.jsonl`;
    writeFileSync(file, '');
    let rows = 0;
    await runPool('gen', games, { seedBase: 1_000_000, policy: opt(args, 'policy', 'random') }, (m) => {
      if (!m.rows.length) return;
      rows += m.rows.length;
      appendFileSync(file, m.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    });
    console.log(`train rows: ${rows} → ${file}`);
  } else if (mode === 'test') {
    const positions = Number(opt(args, 'positions', 300));
    const playouts = Number(opt(args, 'playouts', 64));
    const old = opt(args, 'old', null);
    const file = `${out}/test.jsonl`;
    writeFileSync(file, '');
    await runPool('test', positions, { seedBase: 5_000_000, playouts, old }, (m) => {
      if (m.row && m.row.share !== null) appendFileSync(file, JSON.stringify(m.row) + '\n');
    });
    console.log(`test → ${file}`);
  } else if (mode === 'fit') {
    const base = JSON.parse(readFileSync(`${HERE}/../src/ai-weights.json`, 'utf8'));
    const target = opt(args, 'target', 'chance-weights.json');
    const cur = JSON.parse(readFileSync(`${HERE}/../src/${target}`, 'utf8'));
    const scale = cur.calibration.scale;
    const rows = readFileSync(`${out}/train.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const prior = FEATURES.map((p) => getPath(base, p));
    // Split by game so correlated positions of one game never straddle train/val.
    const isVal = (r) => r.g % 5 === 0;
    const tr = rows.filter((r) => !isVal(r));
    const va = rows.filter(isVal);
    const Xtr = tr.map((r) => r.d), ytr = tr.map((r) => r.y);
    const Xva = va.map((r) => r.d), yva = va.map((r) => r.y);
    const sd = FEATURES.map((_, k) => {
      let m = 0, q = 0;
      for (const x of Xtr) m += x[k];
      m /= Xtr.length;
      for (const x of Xtr) q += (x[k] - m) ** 2;
      return Math.sqrt(q / Xtr.length);
    });
    console.log(`train ${Xtr.length}  val ${Xva.length}`);
    let best = null;
    for (const lambda of [3, 1, 0.3, 0.1, 0.03, 0.01, 0.003, 0.001]) {
      const beta = fitLogistic(Xtr, ytr, prior, sd, lambda, scale);
      const L = logloss(Xva, yva, beta, scale);
      console.log(`λ=${lambda}  val logloss ${L.toFixed(5)}`);
      if (!best || L < best.L) best = { lambda, L, beta };
    }
    const all = rows.map((r) => r.d), ally = rows.map((r) => r.y);
    const beta = fitLogistic(all, ally, prior, sd, best.lambda, scale);
    console.log(`chosen λ=${best.lambda}; base-weights val logloss ${logloss(Xva, yva, [...prior, 10000 / scale], scale).toFixed(5)}`);
    FEATURES.forEach((p, k) => setPath(cur, p, Math.round(beta[k] * 1000) / 1000));
    cur.calibration.biasP1 = Math.round(beta[NF] * scale);
    // lowHpDistBonusMax / hanging shape stay base values (feature shape, see evaluate.ts).
    writeFileSync(`${HERE}/../src/${target}`, JSON.stringify(cur, null, 2) + '\n');
    console.log('\nfeature                               base        fitted');
    FEATURES.forEach((p, k) => console.log(`${p.padEnd(36)} ${String(prior[k]).padStart(10)} ${beta[k].toFixed(1).padStart(12)}`));
    console.log(`biasP1 ${cur.calibration.biasP1}`);
  } else if (mode === 'score') {
    // Compare predictors on the held-out test positions (share of 64 playouts).
    const cur = JSON.parse(readFileSync(`${HERE}/../src/chance-weights.json`, 'utf8'));
    const { scale, biasP1 } = cur.calibration;
    const w = FEATURES.map((p) => getPath(cur, p));
    const test = readFileSync(`${out}/test.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const newP = (d) => sigmoid((d.reduce((a, x, k) => a + x * w[k], 0) + biasP1) / scale);
    const oldP = (od) => sigmoid((od + 10000) / 40000);
    const cutP = (cuts, f) => cuts.reduce((a, c) => a + (c.w !== undefined ? (c.w === 1 ? 1 : 0) : f(c)), 0) / cuts.length;
    const mse = (f) => test.reduce((a, r) => a + (f(r) - r.share) ** 2, 0) / test.length;
    const top = (f) => {
      // Pairwise ranking accuracy: how often the predictor orders two positions like the truth does.
      let ok = 0, n = 0;
      for (let i = 0; i < test.length; i++)
        for (let j = i + 1; j < test.length; j++) {
          const t = test[i].share - test[j].share;
          if (Math.abs(t) < 0.1) continue;
          n++;
          if (Math.sign(f(test[i]) - f(test[j])) === Math.sign(t)) ok++;
        }
      return ok / n;
    };
    const rowsOut = [
      ['flat 50%', () => 0.5],
      ['old formula', (r) => oldP(r.od)],
      ['new formula', (r) => newP(r.d)],
      ['old + 16 cut playouts', (r) => cutP(r.cuts, (c) => oldP(c.od))],
      ['new + 16 cut playouts', (r) => cutP(r.cuts, (c) => newP(c.d))],
    ];
    console.log(`test positions: ${test.length}`);
    for (const [name, f] of rowsOut) console.log(`${name.padEnd(24)} MSE ${mse(f).toFixed(4)}   pair-order ${(top(f) * 100).toFixed(1)}%`);
  }
}
