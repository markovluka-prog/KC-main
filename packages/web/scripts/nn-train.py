#!/usr/bin/env python3
"""
Trains the policy/value network from self-play JSONL (see nn-selfplay.ts) and
exports weights to JSON in the exact shape nn-eval.ts's NNWeights expects, so
the browser/Node forward pass (pure TS, no PyTorch/ONNX at inference time) can
load them directly.

Architecture mirrors nn-eval.ts EXACTLY — see that file's header comment for
why (call-rate: ~1e5 evals/turn, so inference must be a tiny hand-rolled JS
forward pass, not a runtime dependency):

    input = pool5x5(spatial planes) ++ scalar features      [INPUT_SIZE]
    trunk = Dense(128, relu) -> Dense(64, relu)
    value = Dense(64 -> 1, tanh)
    policyTrunk = Dense(64 -> 32, relu)
    policyOut   = Dense(32 + ACTION_FEATURES -> 1, identity)   [scored per candidate]

If you change either file's shape, change both and bump FEATURE_VERSION in
nn-features.ts, or a trained checkpoint will silently misread positions.

Usage:
    python3 scripts/nn-train.py --data scripts/nn-data/*.jsonl \
        --out src/game/nn-weights.json --epochs 10

Policy loss only applies to examples that carry a policyChosenIndex (see
nn-selfplay.ts's coverage note — not every turn produces a match). Value loss
applies to every example. Total loss = value_loss + POLICY_LOSS_WEIGHT *
policy_loss, masked appropriately per batch.
"""
from __future__ import annotations

import argparse
import glob
import json
import random
import sys
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

ROWS = 20
COLS = 20
# Must match nn-features.ts's NUM_PLANES: (7 unit types + 3 stat planes) * 2
# sides + 4 geometry planes.
NUM_PLANES = (7 + 3) * 2 + 4
SCALAR_FEATURES = 9 + 5
POOL_ROWS = 5
POOL_COLS = 5
POOLED_SPATIAL_SIZE = POOL_ROWS * POOL_COLS * NUM_PLANES
INPUT_SIZE = POOLED_SPATIAL_SIZE + SCALAR_FEATURES
HIDDEN_SIZES = [128, 64]
POLICY_HIDDEN = 32
ACTION_FEATURE_WIDTH = 8
POLICY_LOSS_WEIGHT = 0.5


def pool_spatial(spatial: list[float]) -> list[float]:
    """Mirrors nn-eval.ts's poolSpatial: mean-pool ROWSxCOLSxNUM_PLANES down to
    POOL_ROWSxPOOL_COLSxNUM_PLANES, row-major, channel-last, flattened."""
    rows_per = ROWS // POOL_ROWS
    cols_per = COLS // POOL_COLS
    out = [0.0] * POOLED_SPATIAL_SIZE
    count = rows_per * cols_per
    for row in range(ROWS):
        pr = min(POOL_ROWS - 1, row // rows_per)
        for col in range(COLS):
            pc = min(POOL_COLS - 1, col // cols_per)
            base = (row * COLS + col) * NUM_PLANES
            out_base = (pr * POOL_COLS + pc) * NUM_PLANES
            for p in range(NUM_PLANES):
                out[out_base + p] += spatial[base + p] / count
    return out


class SelfPlayDataset(Dataset):
    def __init__(self, examples: list[dict]):
        self.examples = examples

    def __len__(self) -> int:
        return len(self.examples)

    def __getitem__(self, idx: int):
        ex = self.examples[idx]
        pooled = pool_spatial(ex["spatial"])
        x = torch.tensor(pooled + ex["scalar"], dtype=torch.float32)
        value_target = torch.tensor(ex["outcome"], dtype=torch.float32)
        has_policy = "policyChosenIndex" in ex and ex.get("policyFeatures")
        if has_policy:
            feats = torch.tensor(ex["policyFeatures"], dtype=torch.float32)  # [K, 8]
            label = torch.tensor(ex["policyChosenIndex"], dtype=torch.long)
        else:
            feats = torch.zeros((1, ACTION_FEATURE_WIDTH), dtype=torch.float32)
            label = torch.tensor(-1, dtype=torch.long)  # sentinel: no policy loss
        return x, value_target, feats, label


def collate(batch):
    xs = torch.stack([b[0] for b in batch])
    values = torch.stack([b[1] for b in batch])
    # Policy candidates vary in count per example — keep as a list, loss loop
    # handles them one at a time (batch sizes here are small enough that this
    # isn't a performance concern; self-play data is thousands, not millions,
    # of examples).
    feats_list = [b[2] for b in batch]
    labels = torch.stack([b[3] for b in batch])
    return xs, values, feats_list, labels


class KCNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.trunk = nn.ModuleList(
            [
                nn.Linear(INPUT_SIZE, HIDDEN_SIZES[0]),
                nn.Linear(HIDDEN_SIZES[0], HIDDEN_SIZES[1]),
            ]
        )
        self.value_head = nn.Linear(HIDDEN_SIZES[1], 1)
        self.policy_trunk = nn.Linear(HIDDEN_SIZES[1], POLICY_HIDDEN)
        self.policy_out = nn.Linear(POLICY_HIDDEN + ACTION_FEATURE_WIDTH, 1)

    def trunk_forward(self, x: torch.Tensor) -> torch.Tensor:
        h = x
        for layer in self.trunk:
            h = F.relu(layer(h))
        return h

    def value_forward(self, hidden: torch.Tensor) -> torch.Tensor:
        return torch.tanh(self.value_head(hidden)).squeeze(-1)

    def policy_logits(self, hidden_row: torch.Tensor, feats: torch.Tensor) -> torch.Tensor:
        """hidden_row: [H]. feats: [K, ACTION_FEATURE_WIDTH]. Returns [K] logits."""
        ph = F.relu(self.policy_trunk(hidden_row))  # [POLICY_HIDDEN]
        ph_rep = ph.unsqueeze(0).expand(feats.shape[0], -1)  # [K, POLICY_HIDDEN]
        combined = torch.cat([ph_rep, feats], dim=-1)  # [K, POLICY_HIDDEN+8]
        return self.policy_out(combined).squeeze(-1)  # [K]


def load_examples(patterns: list[str]) -> list[dict]:
    paths: list[str] = []
    for pat in patterns:
        paths.extend(sorted(glob.glob(pat)))
    if not paths:
        print(f"No files matched {patterns}", file=sys.stderr)
        sys.exit(1)
    examples: list[dict] = []
    for p in paths:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                examples.append(json.loads(line))
    print(f"Loaded {len(examples)} examples from {len(paths)} file(s)")
    return examples


def dense_layer_to_json(layer: nn.Linear) -> dict:
    return {
        "weights": layer.weight.detach().cpu().tolist(),  # [out][in]
        "bias": layer.bias.detach().cpu().tolist(),
    }


def export_weights(model: KCNet, out_path: Path) -> None:
    payload = {
        "featureVersion": 1,
        "trunk": [dense_layer_to_json(layer) for layer in model.trunk],
        "valueHead": dense_layer_to_json(model.value_head),
        "policyTrunk": dense_layer_to_json(model.policy_trunk),
        "policyOut": dense_layer_to_json(model.policy_out),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    print(f"Exported weights -> {out_path}")


def train(args: argparse.Namespace) -> None:
    examples = load_examples(args.data)
    random.seed(args.seed)
    random.shuffle(examples)
    split = max(1, int(len(examples) * 0.9))
    train_examples, val_examples = examples[:split], examples[split:]
    if not val_examples:
        val_examples = train_examples[-min(50, len(train_examples)) :]

    train_loader = DataLoader(
        SelfPlayDataset(train_examples), batch_size=args.batch_size, shuffle=True, collate_fn=collate
    )
    val_loader = DataLoader(
        SelfPlayDataset(val_examples), batch_size=args.batch_size, shuffle=False, collate_fn=collate
    )

    model = KCNet()
    if args.init_weights and Path(args.init_weights).exists():
        load_weights_into_model(model, Path(args.init_weights))
        print(f"Warm-started from {args.init_weights}")

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    for epoch in range(args.epochs):
        model.train()
        total_value_loss = 0.0
        total_policy_loss = 0.0
        policy_count = 0
        n_batches = 0
        for xs, values, feats_list, labels in train_loader:
            optimizer.zero_grad()
            hidden = model.trunk_forward(xs)  # [B, H]
            value_pred = model.value_forward(hidden)  # [B]
            value_loss = F.mse_loss(value_pred, values)

            policy_loss_terms = []
            for i in range(xs.shape[0]):
                if labels[i].item() < 0:
                    continue
                logits = model.policy_logits(hidden[i], feats_list[i])
                target = labels[i].unsqueeze(0)
                policy_loss_terms.append(F.cross_entropy(logits.unsqueeze(0), target))
            if policy_loss_terms:
                policy_loss = torch.stack(policy_loss_terms).mean()
                loss = value_loss + POLICY_LOSS_WEIGHT * policy_loss
                total_policy_loss += policy_loss.item()
                policy_count += 1
            else:
                loss = value_loss

            loss.backward()
            optimizer.step()
            total_value_loss += value_loss.item()
            n_batches += 1

        avg_value = total_value_loss / max(1, n_batches)
        avg_policy = total_policy_loss / max(1, policy_count)
        val_value_loss = evaluate(model, val_loader)
        print(
            f"epoch {epoch + 1}/{args.epochs}  "
            f"train_value_mse={avg_value:.4f}  train_policy_ce={avg_policy:.4f}  "
            f"val_value_mse={val_value_loss:.4f}"
        )

    export_weights(model, Path(args.out))


def evaluate(model: KCNet, loader: DataLoader) -> float:
    model.eval()
    total = 0.0
    n = 0
    with torch.no_grad():
        for xs, values, _feats_list, _labels in loader:
            hidden = model.trunk_forward(xs)
            value_pred = model.value_forward(hidden)
            total += F.mse_loss(value_pred, values).item()
            n += 1
    return total / max(1, n)


def load_weights_into_model(model: KCNet, path: Path) -> None:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    def load_dense(layer: nn.Linear, spec: dict) -> None:
        with torch.no_grad():
            layer.weight.copy_(torch.tensor(spec["weights"], dtype=torch.float32))
            layer.bias.copy_(torch.tensor(spec["bias"], dtype=torch.float32))

    for layer, spec in zip(model.trunk, data["trunk"]):
        load_dense(layer, spec)
    load_dense(model.value_head, data["valueHead"])
    load_dense(model.policy_trunk, data["policyTrunk"])
    load_dense(model.policy_out, data["policyOut"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", nargs="+", required=True, help="Glob(s) of self-play JSONL files")
    parser.add_argument("--out", default="src/game/nn-weights.json", help="Output weights JSON path")
    parser.add_argument("--init-weights", default=None, help="Warm-start from an existing nn-weights.json")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    main()
