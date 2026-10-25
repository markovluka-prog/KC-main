"""Онлайн-модель «нужна ли эта строка»: логистическая регрессия на хэш-признаках (AdaGrad).

Без зависимостей (чистый Python). Учится на метках из labels.py и (опционально) от Haiku.
Пока положительных меток мало, run_filtered использует прежнее regexp-правило.
"""
import math
import random
import re
import time
import zlib

from common import MODEL, SALIENT, load_json, save_json

DIM = 1 << 16
TOK = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
PATHLINE = re.compile(r"[\w./\\-]+\.\w{1,5}:\d+")
MAX_SCAN = 20000  # на гигантских логах оцениваем не всё


def features(line, rel_pos, fam):
    f = set()
    toks = TOK.findall(line)[:40]
    for t in toks:
        f.add("t:" + t.lower())
    if len(toks) >= 2:
        f.add("b:" + toks[0].lower() + "_" + toks[1].lower())
    if SALIENT.search(line):
        f.add("e")
        f.add("e|" + fam)
    if PATHLINE.search(line):
        f.add("p")
    s = line.lstrip()
    f.add("i%d" % min((len(line) - len(s)) // 2, 4))
    f.add("l%d" % min(int(math.log2(len(line) + 1)), 9))
    f.add("d%d" % int(5 * sum(c.isdigit() for c in line) / max(1, len(line))))
    f.add("r%d" % int(rel_pos * 5))
    f.add("f:" + fam)
    if s.startswith(("File ", "at ", "Traceback", "E ", ">")):
        f.add("tb")
    return [zlib.crc32(x.encode()) & (DIM - 1) for x in f]


class Scorer:
    def __init__(self):
        self.w, self.g = {}, {}
        self.b, self.gb = -3.0, 0.0
        self.n = 0.0      # взвешенное число обучающих строк
        self.n_pos = 0    # положительные метки
        self.meta = {"logs": 0, "ema_model_recall": 0.0, "ema_regex_recall": 0.0, "agree": 0.0}

    def predict(self, feats):
        z = self.b + sum(self.w.get(i, 0.0) for i in feats)
        return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))

    def update(self, feats, y, weight=1.0, lr=0.3):
        err = (self.predict(feats) - y) * weight
        self.gb += err * err
        self.b -= lr * err / (math.sqrt(self.gb) + 1e-8)
        for i in feats:
            self.g[i] = self.g.get(i, 0.0) + err * err
            self.w[i] = self.w.get(i, 0.0) - lr * err / (math.sqrt(self.g[i]) + 1e-8)
        self.n += weight
        self.n_pos += 1 if y else 0

    def base_rate(self):
        return self.n_pos / max(1.0, self.n)

    def _candidates(self, a, b):
        idx = list(range(a, b))
        if len(idx) > MAX_SCAN:
            step = len(idx) // MAX_SCAN + 1
            idx = idx[::step]
        return idx

    def top_lines(self, lines, a, b, cap, fam, mult=1.5):
        """Индексы (с 0) до `cap` самых «нужных» строк из [a, b), в порядке следования."""
        n = max(1, len(lines))
        cand = []
        for i in self._candidates(a, b):
            p = self.predict(features(lines[i], i / n, fam))
            if SALIENT.search(lines[i]):
                p += 0.05
            cand.append((p, i))
        floor = max(0.02, mult * self.base_rate())
        cand = sorted((c for c in cand if c[0] >= floor), reverse=True)[:cap]
        return sorted(i for _, i in cand)

    def train_log(self, lines, pos, fam, rng, deadline, neg_ratio=5, extra_weight=1.0):
        """Все положительные + выборка отрицательных с поправочным весом (калибровка сохраняется)."""
        n = max(1, len(lines))
        pos = sorted(i for i in pos if 0 <= i < len(lines))[:300]
        negs = [i for i in range(len(lines)) if i not in set(pos)]
        k = min(len(negs), max(20, neg_ratio * len(pos)))
        sample = rng.sample(negs, k) if k < len(negs) else negs
        w_neg = (len(negs) / k) if k else 1.0
        batch = [(i, 1, 1.0) for i in pos] + [(i, 0, w_neg) for i in sample]
        rng.shuffle(batch)
        for i, y, w in batch:
            if time.time() > deadline:
                break
            self.update(features(lines[i], i / n, fam), y, w * extra_weight)

    def save(self):
        keep = [i for i, v in self.w.items() if abs(v) > 1e-3]
        save_json(MODEL, {
            "w": {str(i): round(self.w[i], 4) for i in keep},
            "g": {str(i): round(self.g.get(i, 0.0), 4) for i in keep},
            "b": round(self.b, 4), "gb": round(self.gb, 4),
            "n": round(self.n, 2), "n_pos": self.n_pos, "meta": self.meta,
        })


def load():
    s = Scorer()
    d = load_json(MODEL)
    if d:
        s.w = {int(i): v for i, v in d.get("w", {}).items()}
        s.g = {int(i): v for i, v in d.get("g", {}).items()}
        s.b, s.gb = d.get("b", s.b), d.get("gb", 0.0)
        s.n, s.n_pos = d.get("n", 0.0), d.get("n_pos", 0)
        s.meta.update(d.get("meta", {}))
    return s


def regex_lines(lines, a, b, cap):
    sal = [i for i in range(a, b) if SALIENT.search(lines[i])]
    if len(sal) > cap:
        sal = sal[: cap // 2] + sal[-(cap - cap // 2):]
    return sal


def recall_at_cap(scorer, lines, a, b, pos, cap, fam, mult=1.5):
    """Предварительная (до обучения) оценка: какую долю нужных скрытых строк поймали бы модель и regexp."""
    hidden_pos = {i for i in pos if a <= i < b}
    if not hidden_pos or cap <= 0:
        return None
    m = set(scorer.top_lines(lines, a, b, cap, fam, mult))
    r = set(regex_lines(lines, a, b, cap))
    return len(m & hidden_pos) / len(hidden_pos), len(r & hidden_pos) / len(hidden_pos)


def f1(pred, truth):
    pred, truth = set(pred), set(truth)
    if not pred or not truth:
        return 0.0
    tp = len(pred & truth)
    if not tp:
        return 0.0
    p, r = tp / len(pred), tp / len(truth)
    return 2 * p * r / (p + r)


def make_rng(seed=None):
    return random.Random(seed)
