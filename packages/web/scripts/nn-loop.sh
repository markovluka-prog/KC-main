#!/usr/bin/env bash
# One iteration of the self-play -> train -> export cycle for the learned
# policy/value net (see nn-eval.ts, nn-features.ts, nn-selfplay.ts,
# nn-train.py). Run this repeatedly (by hand, or from a scheduler) to keep
# improving the checkpoint.
#
# Usage:
#   scripts/nn-loop.sh [games] [budget_ms] [epochs]
#
# Defaults: 200 games, 300ms/turn teacher budget, 10 epochs.
#
# Each run:
#   1. Generates a fresh self-play dataset (scripts/nn-data/selfplay-<ts>.jsonl)
#   2. Trains from ALL datasets under scripts/nn-data/*.jsonl (so later runs
#      keep learning from earlier games too, not just the newest batch),
#      warm-starting from the previous checkpoint if one exists
#   3. Exports to scripts/nn-data/nn-weights-latest.json
#
# Promoting a checkpoint to ship (src/game/nn-weights.json) and wiring it into
# a preset (ai-config.ts's useNeuralNet) is a SEPARATE, deliberate step —
# this script never does it automatically. Measure first with
#   NNBENCH_WEIGHTS=scripts/nn-data/nn-weights-latest.json pnpm --filter @kc/web run nn:bench
# (see nn-bench.ts) before trusting a checkpoint enough to ship it.
set -euo pipefail
cd "$(dirname "$0")/.."

GAMES="${1:-200}"
BUDGET_MS="${2:-300}"
EPOCHS="${3:-10}"
DATA_DIR="scripts/nn-data"
LATEST="$DATA_DIR/nn-weights-latest.json"
STAMP="$(date +%Y%m%dT%H%M%S)"

mkdir -p "$DATA_DIR"

echo "== [1/3] self-play: $GAMES games @ ${BUDGET_MS}ms/turn =="
SELFPLAY_GAMES="$GAMES" \
  SELFPLAY_BUDGET="$BUDGET_MS" \
  SELFPLAY_MAXTURNS=60 \
  SELFPLAY_OUT="$DATA_DIR/selfplay-$STAMP.jsonl" \
  pnpm run nn:selfplay

echo "== [2/3] training (all datasets under $DATA_DIR) =="
INIT_ARGS=()
if [ -f "$LATEST" ]; then
  INIT_ARGS=(--init-weights "$LATEST")
  echo "   warm-starting from $LATEST"
fi
python3 scripts/nn-train.py \
  --data "$DATA_DIR"/*.jsonl \
  --out "$LATEST" \
  --epochs "$EPOCHS" \
  "${INIT_ARGS[@]}"

echo "== [3/3] done =="
echo "Latest checkpoint: $LATEST"
echo "To measure it against the shipped bot:"
echo "  NNBENCH_WEIGHTS=$LATEST pnpm --filter @kc/web run nn:bench"
echo "To ship it: cp $LATEST src/game/nn-weights.json, then flip useNeuralNet on the preset you want it in (ai-config.ts)."
