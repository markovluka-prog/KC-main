import type { BeamDifficulty } from '@kc/game-rules';

export interface AIConfig {
  label: string;
  frameWait: number;
  combinationLimit: number;
  randomMoveChance: number;
  mistakeChance: number;
  skipChance: number;
  threatBlindness: number;
  spellReluctance: number;
  scoreNoise: number;
  useMinimax: boolean;
  minimaxDepth: number;
  focusFireWeight: number;
  comboDetection: boolean;
  territoryWeight: number;
  sacrificeEval: boolean;
  // ---- Phase 2 AI search params (used only when useMinimax === true) ----
  searchBreadth: number;
  searchNodeBudget: number;
  searchTimeBudgetMs: number;
  castleApproachWeight: number;
  opponentThreatWeight: number;
  cohesionWeight: number;
  archerKiteWeight: number;
  cavalryFlankWeight: number;
  knightTankWeight: number;
  smartSpells: boolean;
  // Economy aggression: how hard the AI pursues artifacts in ruins, crafts
  // weapons (swords/bows), and brews potions, and how much it denies a human
  // who camps the ruins. 0 = ignores economy, higher = arms up proactively.
  economyWeight: number;
  // ---- Phase 3 MCTS params (used only when useMCTS === true) ----
  useMCTS: boolean;
  mctsTimeBudgetMs: number; // wall-clock budget per turn in ms
  mctsRolloutDepth: number; // full turns to simulate per rollout
  mctsBreadth: number; // candidate turn-plans generated per node (hard cap)
  // ---- UCT exploration constant `c`. This is the primary DIFFICULTY dial that
  // does not weaken the code: a HIGH c makes the bot spread its rollouts over
  // many plans, so it often commits to a merely-decent line (unpredictable,
  // experimental, beatable). A LOW c makes it pour the budget into the single
  // best line (consistent, sharp). Defaults to √2 (the textbook value) when a
  // saved config predates this field.
  mctsExploration?: number;
  // ---- Softmax temperature for the FINAL root choice. 0 = always take the
  // most-visited plan (deterministic, strongest). Higher = sample among the
  // plans proportionally to visits^(1/T), so a strong-but-not-best plan gets
  // picked sometimes. This is "noise on the final decision weighted by node
  // strength" — the bot still never picks a plan it believes is bad, it just
  // stops being perfectly predictable game after game.
  mctsSelectionTemp?: number;
  // ---- Progressive Widening. A node with N visits is allowed
  // min(mctsBreadth, k·N^alpha) children, so cheap unexplored branches stay
  // narrow while the main line widens. Set pwAlpha to 0 to disable widening and
  // fall back to the old fixed-breadth behaviour.
  pwAlpha?: number;
  pwK?: number;
  // ---- Escape hatch for A/B measurement only. When true the tree backs values
  // up by plain averaging (the behaviour before the minimax-aware backup was
  // added). Averaging at an opponent node assumes they reply at random, which
  // hides forced refutations; the fix is on by default and this exists so
  // `BENCH_PRESET=minimax` can measure what it is worth. Do not ship it true.
  flatBackup?: boolean;
  // ---- RAVE / AMAF. Shares rollout statistics between sibling plans that use
  // the same underlying unit actions, so the search converges faster when
  // branching is wide.
  //
  // MEASURED (scripts/ai-bench.ts, 30 games @300ms, 2026-08-05): RAVE on vs off
  // scored 36.7% — a ~3σ LOSS — and halved throughput (177k vs 334k iters/turn).
  // The bookkeeping (a Map update per node per iteration) costs more than the
  // faster convergence returns here, and this game's plans are order-dependent,
  // which is the case AMAF's all-moves-as-first assumption handles worst.
  // Progressive Widening alone measured 56.7%; PW+RAVE fell back to 46.7%.
  //
  // So: kept implemented and testable, but OFF in every shipped preset. Re-run
  // `BENCH_PRESET=rave pnpm --filter @kc/web bench` before enabling it anywhere.
  useRAVE?: boolean;
  accurateThreatModel?: boolean;
  // ---- Escape hatch for A/B measurement only. When true, candidate turn-plans
  // are generated the old way: dedup by action SEQUENCE (so permutations of the
  // same turn count as distinct candidates) and complete every plan with the
  // one identical greedy tail. That made extra search time nearly worthless —
  // the tree could not represent a turn where two units coordinate. Exists so
  // `BENCH_PRESET=plans` can measure the fix. Do not ship it true.
  legacyPlanGen?: boolean;
  // Controls how fast the AMAF estimate decays out in favour of true statistics.
  // LARGER = decays sooner. The textbook Go value (~1e-4) is far too small here:
  // this game's turn-plans are order-dependent, so a long-lived AMAF term buries
  // immediate tactics — at 1e-4..1e-2 the search demonstrably walks past a free
  // lethal capture. 0.05 keeps the convergence benefit while letting real visits
  // take over quickly enough to preserve tactical sight.
  raveBias?: number;
  // ---- THE intelligence dial — turn this ONE number up and the AI thinks
  // proportionally harder (more search time, deeper rollouts, wider branching,
  // bigger minimax depth/node budget). 1 = the preset's tuned default. 10 =
  // ~10× the thinking. 1_000_000 = effectively "max" (each move can take a long
  // time, but plays as strong as the engine allows). It does NOT change the
  // heuristics — only how much the engine searches with them. Optional so old
  // saved configs default to 1.
  intelligence?: number;
  // When true, TRUST the search: applyStrategicOverlay keeps the MCTS/minimax
  // plan as-is (only filling in units the search left idle) instead of rewriting
  // it with the scenario march/rally/farmer script. On a strong search (hard, high
  // intelligence) the script was overwriting the deep plan, so the extra thinking
  // "didn't help". Weak presets keep the script (it carries them). Default false.
  trustSearch?: boolean;
  // ---- Phase/goal strategy planner (replaces the old Q-learning brain) ----
  // The AI derives a game PHASE (expand → mass → assault) and a strategic GOAL
  // each turn, then adds a small directional bias toward that goal on top of the
  // tuned tactical heuristic. It nudges/breaks ties toward the right long-term
  // plan; it does NOT override the heuristic (those scores are in the tens of
  // thousands). 0 = pure tactics, higher = stronger strategic pull.
  strategyWeight: number;
  // ---- DEPRECATED: Q-learning brain. The tabular Q-table did not learn (≈90%
  // self-play draws, flat win-rate over 219k games), so it was replaced by the
  // phase/goal planner above. Kept (off) only so older saved custom configs that
  // still carry these keys don't break. Always treat as disabled.
  useQBrain?: boolean;
  qBrainWeight?: number;
  // ---- Beam search engine (plan step 6). When set, createTurnPlan() routes
  // through packages/game-rules's planTurn/planTurnWithReply (via
  // beam-bridge.ts) INSTEAD of combo-detection/MCTS/minimax, using the named
  // BeamDifficulty preset's beamWidth/reply/noise. This is an opt-in
  // alternative engine for A/B measurement (scripts/arena.js, plan step 7) —
  // no shipped preset in AI_DIFFICULTY sets this yet. Once the arena shows it
  // wins convincingly, promoting it to the default (and deleting
  // detectCombos/comboIsProfitable/buildComboPlan/isSafePositionIgnoring) is
  // plan step 8, not this one.
  useBeamSearch?: BeamDifficulty;
  // ---- Learned policy/value network (AlphaZero-style self-play), see
  // nn-eval.ts / nn-features.ts. When true AND an AIPlayer has had
  // setNNEvaluator() called with a loaded net, mctsRollout uses the net's
  // value head as the leaf evaluation instead of a greedy playout +
  // evaluateLightState, and computePlanStarters blends in the net's policy
  // head when ranking candidate first-actions. Off by default: an AIPlayer
  // with this true but no evaluator injected silently behaves exactly like
  // before (the existing heuristic path runs unchanged), so flipping it on
  // for a preset is safe even before a net has been trained.
  useNeuralNet?: boolean;
  // 0 = trust the net's value head completely at the leaf (pure AlphaZero).
  // >0 blends in evaluateLightState's static eval too, weighted by this
  // fraction — a hedge for early training, when the net is weaker than the
  // hand-tuned eval it's meant to replace. Ignored when useNeuralNet is false.
  neuralNetBlend?: number;
}

// ---- Strategy planning: computeStrategy() in ai.ts uses a GOAP planner
// (src/game/goap.ts: preconditions/effects + backward chaining) to pick the
// stage/goal, and assignRoles() (also goap.ts) to assign farmers/vanguard/
// bridge squad. This replaced a hardcoded if/else stage ladder — no fallback
// flag is kept; see /Users/free/.claude/plans/happy-beaming-cosmos.md for the
// rollout notes (the originally planned ≥60% A/B promotion gate was dropped —
// the bench/gauntlet test harness measures raw MCTS and doesn't exercise
// applyStrategicOverlay at all, so no A/B number from it would have been
// meaningful without separately fixing that harness gap first).

export type AIDifficulty = 'easy' | 'medium' | 'hard' | 'impossible';

// DIFFICULTY PHILOSOPHY (reworked): strength = search depth + evaluation
// quality, NOT random blunders. The old "handicap" knobs (randomMoveChance,
// mistakeChance, skipChance, threatBlindness, big scoreNoise) made the AI walk
// into death, skip units and play random moves — i.e. look broken. They are now
// 0/minimal everywhere. EASY is weak because it looks only 1 ply ahead and
// plays simply (no combos, light economy); it does NOT suicide. MEDIUM is a
// genuine challenge (3-ply, full tactics + economy). HARD uses MCTS with deep
// rollouts — sees 10+ turns ahead, effectively unbeatable.
export const AI_DIFFICULTY: Record<AIDifficulty, AIConfig> = {
  // EASY: shallow (depth 1), honest, simple. Beatable by a thinking human, but
  // never makes absurd moves — no random turns, no skipped units, avoids
  // obvious death. Weakness comes from not planning combos/traps and using the
  // economy lightly.
  easy: {
    label: 'Слабый',
    frameWait: 20,
    combinationLimit: 20,
    randomMoveChance: 0,
    mistakeChance: 0,
    skipChance: 0,
    threatBlindness: 0,
    spellReluctance: 0.2,
    scoreNoise: 100,
    useMinimax: true,
    minimaxDepth: 1,
    focusFireWeight: 0.5,
    comboDetection: true,
    territoryWeight: 0.5,
    sacrificeEval: false,
    searchBreadth: 5,
    searchNodeBudget: 2500,
    searchTimeBudgetMs: 120,
    castleApproachWeight: 1.2,
    opponentThreatWeight: 0.8,
    cohesionWeight: 0.3,
    archerKiteWeight: 0.5,
    cavalryFlankWeight: 0.5,
    knightTankWeight: 0.4,
    smartSpells: true,
    economyWeight: 0.6,
    useMCTS: true,
    mctsTimeBudgetMs: 400,
    mctsRolloutDepth: 5,
    mctsBreadth: 5,
    // Weak on purpose, WITHOUT blunders: a wide exploration constant spreads the
    // few rollouts it gets over many plans, and a warm selection temperature
    // means it often plays the 2nd/3rd best of them. The result is a bot that
    // varies between games and misses the sharpest line — not one that suicides.
    mctsExploration: 2.2,
    mctsSelectionTemp: 1.2,
    pwAlpha: 0.45,
    pwK: 1.5,
    strategyWeight: 1.0,
    intelligence: 1,
  },
  // MEDIUM: genuine 3-ply minimax, all tactical weights on, no handicaps, no
  // noise, full economy (crafts weapons, brews potions). Hard for a human but
  // beatable with good play.
  medium: {
    label: 'Средний',
    frameWait: 12,
    combinationLimit: 100,
    randomMoveChance: 0,
    mistakeChance: 0,
    skipChance: 0,
    threatBlindness: 0,
    spellReluctance: 0,
    scoreNoise: 0,
    useMinimax: true,
    minimaxDepth: 3,
    focusFireWeight: 0.8,
    comboDetection: true,
    territoryWeight: 1.0,
    sacrificeEval: true,
    searchBreadth: 9,
    searchNodeBudget: 12000,
    searchTimeBudgetMs: 400,
    castleApproachWeight: 1.9,
    opponentThreatWeight: 1.2,
    cohesionWeight: 0.5,
    archerKiteWeight: 0.8,
    cavalryFlankWeight: 0.8,
    knightTankWeight: 0.7,
    smartSpells: true,
    economyWeight: 1.0,
    useMCTS: true,
    mctsTimeBudgetMs: 1200,
    mctsRolloutDepth: 9,
    mctsBreadth: 8,
    // Mostly sharp, with a touch of unpredictability so repeated games differ.
    mctsExploration: 1.6,
    mctsSelectionTemp: 0.4,
    pwAlpha: 0.45,
    pwK: 1.5,
    strategyWeight: 1.6,
    // ~2.5s of search per turn. Genuinely strong tactically, but keeps the
    // scenario overlay (trustSearch stays off) so it still plays the readable
    // sally→ruins→bridge game-plan a human can learn to counter.
    intelligence: 2,
  },
  // HARD: MCTS with 1.5s budget per turn + 10-turn deep rollouts. Sees far
  // beyond what minimax can reach and improves naturally with more time.
  hard: {
    label: 'Сложный',
    useBeamSearch: 'hard',
    frameWait: 10,
    combinationLimit: 200,
    randomMoveChance: 0,
    mistakeChance: 0,
    skipChance: 0,
    threatBlindness: 0,
    spellReluctance: 0,
    scoreNoise: 0,
    useMinimax: true,
    minimaxDepth: 5,
    focusFireWeight: 1.0,
    comboDetection: true,
    territoryWeight: 1.0,
    sacrificeEval: true,
    searchBreadth: 28, // wider: consider more move-plans, miss fewer strong lines
    searchNodeBudget: 40000,
    searchTimeBudgetMs: 900,
    castleApproachWeight: 2.4,
    opponentThreatWeight: 1.8,
    cohesionWeight: 0.6,
    archerKiteWeight: 1.0,
    cavalryFlankWeight: 1.3,
    knightTankWeight: 1.0,
    smartSpells: true,
    economyWeight: 1.3,
    useMCTS: true,
    mctsTimeBudgetMs: 1500,
    // Short on purpose. A rollout is a greedy playout for BOTH sides, so its
    // signal decays fast with length while its cost grows linearly — at depth 10
    // one iteration cost ~2.8 ms, and the entire budget bought only a few
    // hundred samples spread over 18 root children. Measured head-to-head at
    // identical settings, depth 4 beat depth 10 on both sides of the board, 2-0.
    // The time budget is the lever for strength; depth is not.
    mctsRolloutDepth: 4,
    // Breadth is now a CAP, not a fixed width. Previously every node paid for
    // all 10 candidate plans up front (each one a full greedy turn simulation),
    // so a wide tree burned the budget on plan GENERATION and stayed shallow —
    // which is why raising it used to make the bot worse, not better. With
    // Progressive Widening a node earns children as it accumulates visits, so
    // rarely-visited branches cost 1 plan while the main line is free to widen.
    // That makes a higher cap safe and lets the deep budget find sharp lines
    // the old 10-plan window could miss.
    mctsBreadth: 18,
    // Sharp and consistent: pour the budget into the single best line, and
    // always play the most-visited plan (no sampling).
    mctsExploration: 1.1,
    mctsSelectionTemp: 0,
    pwAlpha: 0.45,
    pwK: 1.5,
    strategyWeight: 2.0,
    trustSearch: true, // hard's deep search drives; don't overwrite it with the script
    // 1500ms × 8 = ~12s of real search per turn, matching the chosen budget.
    // Combined with the fixed branching above, that budget now goes into tree
    // DEPTH — the bot resolves multi-turn tactics (trades, castle races) rather
    // than re-scoring a huge pile of shallow candidate plans.
    intelligence: 8,
  },
  // IMPOSSIBLE: same engine as HARD (MCTS + minimax + GOAP + beam search),
  // pushed to the top of every dial. Not a new algorithm — HARD was already
  // "effectively unbeatable" by design; this exists because a strong human
  // still found lines through it. The `intelligence` dial (see ai.ts: iq(),
  // scaleBudget, scaleSearch) is the engine author's own "max strength, time
  // doesn't matter" lever: time/node budgets scale LINEARLY with it, depth/
  // breadth scale with √it. At intelligence 60 that's ~7.7× HARD's linear
  // budgets and ~2.7× its depth/breadth — several times deeper reads with a
  // wider net, at the cost of several seconds more thinking per turn, which
  // is the intended tradeoff for a difficulty tier that must not lose.
  impossible: {
    label: 'Невозможный',
    // NOTE: createTurnPlan() tries useBeamSearch FIRST and, if it returns a
    // plan, short-circuits before ever reaching MCTS/minimax below — so this
    // must point at the strongest beam preset ('impossible' in beam-presets.ts,
    // wider beam + deeper reply lookahead than 'expert'), not 'hard'. Pointing
    // it at 'hard' here would silently waste every dial turned up below: the
    // beam search would decide the turn before intelligence-scaled MCTS ever ran.
    useBeamSearch: 'impossible',
    frameWait: 10,
    combinationLimit: 200,
    randomMoveChance: 0,
    mistakeChance: 0,
    skipChance: 0,
    threatBlindness: 0,
    spellReluctance: 0,
    scoreNoise: 0,
    useMinimax: true,
    minimaxDepth: 6,
    focusFireWeight: 1.0,
    comboDetection: true,
    territoryWeight: 1.0,
    sacrificeEval: true,
    // Base budgets start at HARD's own numbers; `intelligence` below scales
    // them further at runtime (scaleBudget = linear, scaleSearch = √iq).
    searchBreadth: 28,
    searchNodeBudget: 40000,
    searchTimeBudgetMs: 900,
    castleApproachWeight: 2.6,
    opponentThreatWeight: 2.0,
    cohesionWeight: 0.6,
    archerKiteWeight: 1.1,
    cavalryFlankWeight: 1.4,
    knightTankWeight: 1.1,
    smartSpells: true,
    economyWeight: 1.4,
    useMCTS: true,
    mctsTimeBudgetMs: 1500,
    mctsRolloutDepth: 4,
    mctsBreadth: 18,
    // Maximally sharp and 100% deterministic: always the single best line the
    // (much deeper) search found, never a sampled runner-up.
    mctsExploration: 1.0,
    mctsSelectionTemp: 0,
    pwAlpha: 0.45,
    pwK: 1.5,
    strategyWeight: 2.0,
    trustSearch: true, // never let the scenario script overwrite the search
    // THE lever: 60 turns HARD's ~12s/turn search budget into ~90s/turn
    // (linear) with ~2.7× the depth/breadth (√60 ≈ 7.7). Genuinely slow to
    // move, but it is searching far enough ahead that a human can no longer
    // out-calculate it — strength over speed, exactly as requested.
    intelligence: 60,
  },
};
