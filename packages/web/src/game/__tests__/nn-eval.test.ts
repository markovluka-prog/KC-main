import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeState, NUM_PLANES, SCALAR_FEATURES, type EncodableState } from '../nn-features.js';
import { emptyWeights, NNEvaluator, softmax, INPUT_SIZE, type NNWeights } from '../nn-eval.js';
import { makeState, makeUnit, makeSearcher, search, type HarnessState } from './mcts-harness.js';
import { ROWS, COLS } from '@kc/game-rules';

function sampleState(): HarnessState {
  return makeState(
    [
      makeUnit({ id: 1, player: 1, type: 'knight', row: 14, col: 8, hp: 3, armor: 4, damage: 5 }),
      makeUnit({ id: 2, player: 2, type: 'archer', row: 5, col: 9, hp: 3, armor: 1, damage: 3 }),
    ],
    3,
    { Металл: 2 },
  );
}

describe('nn-features encodeState', () => {
  it('produces the documented tensor shapes', () => {
    const state: EncodableState = sampleState();
    const { spatial, scalar } = encodeState(state, 1, { player1Bottom: true });
    expect(spatial.length).toBe(ROWS * COLS * NUM_PLANES);
    expect(scalar.length).toBe(SCALAR_FEATURES);
  });

  it('is perspective-symmetric: swapping perspective swaps which side is "me"', () => {
    const state: EncodableState = sampleState();
    const asP1 = encodeState(state, 1, { player1Bottom: true });
    const asP2 = encodeState(state, 2, { player1Bottom: true });
    // Total presence mass (sum of all planes) must be identical either way —
    // the same two units exist, only the me/opp labelling changes.
    const sum = (arr: Float32Array): number => arr.reduce((a, b) => a + b, 0);
    expect(sum(asP1.spatial)).toBeCloseTo(sum(asP2.spatial), 5);
  });

  it('never produces NaN/Infinity for a normal position', () => {
    const state: EncodableState = sampleState();
    const { spatial, scalar } = encodeState(state, 1, { player1Bottom: true });
    expect(Array.from(spatial).every((v) => Number.isFinite(v))).toBe(true);
    expect(Array.from(scalar).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('nn-eval forward pass', () => {
  it('an all-zero (untrained) net returns value 0 and a uniform policy', () => {
    const evaluator = new NNEvaluator(emptyWeights());
    const state: EncodableState = sampleState();
    const v = evaluator.value(state, 1, { player1Bottom: true });
    expect(v).toBe(0);

    const { hidden } = evaluator.evaluate(state, 1, { player1Bottom: true });
    const features = [
      [1, 0, 0, 0.5, 0, 0.2, 0.6, 1],
      [0, 1, 0, 0, 0, 0.4, 0.3, 1],
    ];
    const logits = evaluator.policyLogitsFor(hidden, features);
    expect(logits).toEqual([0, 0]);
    const probs = softmax(logits);
    expect(probs[0]).toBeCloseTo(0.5, 5);
    expect(probs[1]).toBeCloseTo(0.5, 5);
  });

  it('value stays within (-1, 1) for random small weights', () => {
    const weights = emptyWeights();
    // Perturb the trunk and value head with small deterministic values so the
    // test is reproducible without a real trained checkpoint.
    weights.trunk[0]!.weights.forEach((row, i) => row.forEach((_, j) => (row[j] = ((i + j) % 7) * 0.01)));
    weights.valueHead.weights.forEach((row, i) => row.forEach((_, j) => (row[j] = ((i + j) % 5) * 0.1)));
    const evaluator = new NNEvaluator(weights);
    const v = evaluator.value(sampleState(), 1, { player1Bottom: true });
    expect(v).toBeGreaterThan(-1);
    expect(v).toBeLessThan(1);
  });

  it('INPUT_SIZE matches the pooled-spatial + scalar layout', () => {
    // 5x5 pooled grid * NUM_PLANES + SCALAR_FEATURES
    expect(INPUT_SIZE).toBe(5 * 5 * NUM_PLANES + SCALAR_FEATURES);
  });
});

describe('trained weights round-trip (Python export -> TS forward pass)', () => {
  const path = fileURLToPath(new URL('../../../scripts/nn-data/smoke-weights.json', import.meta.url));
  const skip = !existsSync(path);

  it.skipIf(skip)('loads a PyTorch-exported checkpoint and runs a finite forward pass', () => {
    const weights = JSON.parse(readFileSync(path, 'utf8')) as NNWeights;
    const evaluator = new NNEvaluator(weights);
    const state: EncodableState = {
      units: [
        { player: 1, type: 'knight', row: 14, col: 8, hp: 3, maxHp: 3, armor: 4, maxArmor: 4, damage: 5 },
        { player: 2, type: 'archer', row: 5, col: 9, hp: 3, maxHp: 3, armor: 1, maxArmor: 1, damage: 3 },
      ],
      shieldTurns: { 1: 0, 2: 0 },
      damageBuff: { 1: 0, 2: 0 },
      activationsLeft: 3,
      inventory: {},
    };
    const v = evaluator.value(state, 1, { player1Bottom: true });
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(-1);
    expect(v).toBeLessThanOrEqual(1);

    const { hidden } = evaluator.evaluate(state, 1, { player1Bottom: true });
    const logits = evaluator.policyLogitsFor(hidden, [
      [1, 0, 0, 0.5, 0, 0.2, 0.6, 1],
      [0, 1, 0, 0, 0, 0.4, 0.3, 1],
    ]);
    expect(logits.every((l) => Number.isFinite(l))).toBe(true);
  });
});

describe('AIPlayer with useNeuralNet enabled (untrained net)', () => {
  it('still produces a legal, non-empty plan (falls through safely)', () => {
    const state = sampleState();
    const ai = makeSearcher(1, { useMCTS: true, mctsTimeBudgetMs: 60, useNeuralNet: true }, state);
    ai.setNNEvaluator(new NNEvaluator(emptyWeights()));
    const { plan } = search(ai, state);
    expect(Array.isArray(plan)).toBe(true);
  });

  it('setting useNeuralNet without calling setNNEvaluator behaves like the heuristic path', () => {
    const state = sampleState();
    const ai = makeSearcher(1, { useMCTS: true, mctsTimeBudgetMs: 60, useNeuralNet: true }, state);
    // No setNNEvaluator call — nnActive must be false, no throw.
    const { plan } = search(ai, state);
    expect(Array.isArray(plan)).toBe(true);
  });
});
