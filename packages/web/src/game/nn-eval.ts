/**
 * Pure-TS forward pass for the learned policy/value network (AlphaZero-style).
 *
 * Deliberately NOT a full conv net: the search calls this once per MCTS leaf,
 * and `ai-config.ts` documents 177k-334k iterations per turn for the old
 * hand-rolled eval (see the RAVE benchmark note). A hand-rolled JS conv over a
 * 20x20x18 plane stack at that call rate would dominate the turn budget
 * before the search could do anything with the extra accuracy. Instead:
 *
 *   1. A single strided-mean pool shrinks the spatial planes from 20x20 to a
 *      5x5 grid (16 cells averaged per bucket) — cheap (one pass, no
 *      multiply-accumulate per output pixel) and keeps rough piece geometry
 *      (which quadrant units are massed in, castle proximity) that a flat
 *      global-average would throw away entirely.
 *   2. The pooled grid (5*5*NUM_PLANES) is concatenated with the scalar
 *      features and fed through a small MLP trunk (see HIDDEN_SIZES).
 *   3. Two heads read the trunk's last hidden layer: `value` (tanh, one
 *      scalar, matches the (-1,1) range mctsRollout already normalises
 *      static eval into) and `policy` (a fixed-size logit vector scored
 *      against candidate actions by nnPolicyScore, see ai.ts's integration).
 *
 * Weights are plain nested arrays loaded from nn-weights.json (produced by
 * scripts/nn-train.py). Missing/untrained weights fall back to all-zero
 * layers, which make `value()` return 0 (a "no opinion" prior) rather than
 * throwing — so the search can run against an untrained net without special
 * casing during early bring-up.
 */
import type { Player } from '@kc/game-rules';
import { ROWS, COLS } from '@kc/game-rules';
import {
  encodeState,
  NUM_PLANES,
  SCALAR_FEATURES,
  type EncodableState,
  type BoardOrientation,
} from './nn-features.js';

/** Spatial pooling grid — 5x5 buckets over the 20x20 board (4x4 cells each). */
const POOL_ROWS = 5;
const POOL_COLS = 5;
const POOLED_SPATIAL_SIZE = POOL_ROWS * POOL_COLS * NUM_PLANES;
export const INPUT_SIZE = POOLED_SPATIAL_SIZE + SCALAR_FEATURES;

/** Trunk hidden layer widths. Small on purpose — see file header. */
export const HIDDEN_SIZES = [128, 64] as const;

/** Policy head size: one logit per (unitSlot, actionSlot) bucket. The search
 *  doesn't enumerate a fixed action space (legal moves vary with position), so
 *  the policy head instead scores a small fixed set of ACTION FEATURES per
 *  candidate (see encodeActionFeatures in ai.ts's integration) rather than
 *  indexing a global move vocabulary — this output width is that feature
 *  vector's hidden width, not a move count. */
export const POLICY_HIDDEN = 32;

export interface DenseLayer {
  /** weights[outIdx][inIdx] */
  weights: number[][];
  bias: number[];
}

export interface NNWeights {
  featureVersion: number;
  trunk: DenseLayer[]; // INPUT_SIZE -> HIDDEN_SIZES[0] -> HIDDEN_SIZES[1]
  valueHead: DenseLayer; // HIDDEN_SIZES[last] -> 1
  policyTrunk: DenseLayer; // HIDDEN_SIZES[last] -> POLICY_HIDDEN
  /** Applied to [policyTrunk output ++ per-action features] -> 1 logit. Sized
   *  lazily against whatever action-feature width the caller uses. */
  policyOut: DenseLayer;
}

function zeroLayer(inSize: number, outSize: number): DenseLayer {
  return {
    weights: Array.from({ length: outSize }, () => new Array(inSize).fill(0)),
    bias: new Array(outSize).fill(0),
  };
}

/** An all-zero net: value() always returns 0, policy logits are always equal
 *  (uniform). Safe default before a trained nn-weights.json is loaded. */
export function emptyWeights(policyActionFeatureWidth = 8): NNWeights {
  return {
    featureVersion: 1,
    trunk: [zeroLayer(INPUT_SIZE, HIDDEN_SIZES[0]), zeroLayer(HIDDEN_SIZES[0], HIDDEN_SIZES[1])],
    valueHead: zeroLayer(HIDDEN_SIZES[1], 1),
    policyTrunk: zeroLayer(HIDDEN_SIZES[1], POLICY_HIDDEN),
    policyOut: zeroLayer(POLICY_HIDDEN + policyActionFeatureWidth, 1),
  };
}

function relu(x: number): number {
  return x > 0 ? x : 0;
}

function denseForward(layer: DenseLayer, input: readonly number[], activation: (x: number) => number): number[] {
  const out = new Array(layer.weights.length);
  for (let o = 0; o < layer.weights.length; o += 1) {
    const row = layer.weights[o]!;
    let sum = layer.bias[o] ?? 0;
    for (let i = 0; i < row.length; i += 1) sum += row[i]! * (input[i] ?? 0);
    out[o] = activation(sum);
  }
  return out;
}

function identity(x: number): number {
  return x;
}

/** Mean-pool the spatial tensor from ROWS x COLS x NUM_PLANES down to
 *  POOL_ROWS x POOL_COLS x NUM_PLANES, then flatten. */
function poolSpatial(spatial: Float32Array): number[] {
  const rowsPerBucket = ROWS / POOL_ROWS;
  const colsPerBucket = COLS / POOL_COLS;
  const out = new Array(POOLED_SPATIAL_SIZE).fill(0);
  const count = rowsPerBucket * colsPerBucket;
  for (let row = 0; row < ROWS; row += 1) {
    const pr = Math.min(POOL_ROWS - 1, Math.floor(row / rowsPerBucket));
    for (let col = 0; col < COLS; col += 1) {
      const pc = Math.min(POOL_COLS - 1, Math.floor(col / colsPerBucket));
      const base = (row * COLS + col) * NUM_PLANES;
      const outBase = (pr * POOL_COLS + pc) * NUM_PLANES;
      for (let p = 0; p < NUM_PLANES; p += 1) {
        out[outBase + p] += spatial[base + p]! / count;
      }
    }
  }
  return out;
}

/** Runs the trunk once, producing the shared hidden representation both heads
 *  read from. Callers that need value + policy for the same position should
 *  call this once and reuse the result rather than calling value()/policy()
 *  separately (see NNEvaluator below). */
export function trunkForward(weights: NNWeights, state: EncodableState, perspective: Player, orientation: BoardOrientation): number[] {
  const { spatial, scalar } = encodeState(state, perspective, orientation);
  let x: number[] = poolSpatial(spatial).concat(Array.from(scalar));
  for (const layer of weights.trunk) {
    x = denseForward(layer, x, relu);
  }
  return x;
}

/** Value estimate in (-1, 1) from `perspective`'s point of view — same scale
 *  mctsRollout already normalises evaluateLightState into via tanh, so it
 *  drops in as a direct replacement for that final static-eval call. */
export function valueForward(weights: NNWeights, hidden: readonly number[]): number {
  const out = denseForward(weights.valueHead, hidden, Math.tanh);
  return out[0] ?? 0;
}

/** Scores ONE candidate action given the trunk's hidden state and that
 *  action's own small feature vector (see ai.ts's encodeActionFeatures).
 *  Returns a raw logit; caller softmaxes across candidates. */
export function policyLogit(weights: NNWeights, hidden: readonly number[], actionFeatures: readonly number[]): number {
  const policyHidden = denseForward(weights.policyTrunk, hidden, relu);
  const combined = policyHidden.concat(Array.from(actionFeatures));
  const out = denseForward(weights.policyOut, combined, identity);
  return out[0] ?? 0;
}

/** Softmax a list of logits into a probability distribution. Numerically
 *  stable (subtracts the max before exponentiating). */
export function softmax(logits: readonly number[]): number[] {
  if (logits.length === 0) return [];
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

/** Thin stateful wrapper so ai.ts can hold one evaluator instance and call
 *  .value()/.policy() without re-threading `weights` everywhere. */
export class NNEvaluator {
  constructor(public weights: NNWeights) {}

  value(state: EncodableState, perspective: Player, orientation: BoardOrientation): number {
    const hidden = trunkForward(this.weights, state, perspective, orientation);
    return valueForward(this.weights, hidden);
  }

  /** Returns { hidden, value } so a caller that also wants policy logits for
   *  the same position doesn't pay for the trunk forward pass twice. */
  evaluate(state: EncodableState, perspective: Player, orientation: BoardOrientation): { hidden: number[]; value: number } {
    const hidden = trunkForward(this.weights, state, perspective, orientation);
    return { hidden, value: valueForward(this.weights, hidden) };
  }

  policyLogitsFor(hidden: readonly number[], actionFeaturesList: readonly (readonly number[])[]): number[] {
    return actionFeaturesList.map((f) => policyLogit(this.weights, hidden, f));
  }
}
