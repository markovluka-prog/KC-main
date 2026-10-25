#!/usr/bin/env python3
"""Stop-хук: обучение после каждого хода. Конфиги меняются «на ходу».

Что происходит на каждом Stop:
  1. Метки из transcript: какие строки сохранённых логов Claude реально использовал
     (labels.py) -> онлайн-обучение модели отбора строк (scorer.py).
  2. (Если включено) Haiku иногда размечает лог как «учитель» — доля вызовов падает по мере
     того, как локальная модель с ним согласуется.
  3. MCTS (UCT) отдельно для каждого семейства команд: награда = экономия вывода
     − штрафы за «добор» и за цитаты Claude, которых не было на экране.
  4. Предсказание роста контекста -> предупреждение пользователю про /compact.

CLI:  tuner.py --status | --reset | --freeze | --unfreeze | --haiku on|off
"""
import argparse
import collections
import json
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (CONFIG, DEFAULT_PATH, INNER, ORDER, SPACE, TREES, append_event,  # noqa: E402
                    load_config, load_json, lock, read_events, rotate_events, save_json)
import ctxpred  # noqa: E402
import haiku  # noqa: E402
import labels  # noqa: E402
import scorer  # noqa: E402

SHRINK = 3  # виртуальные замеры со средним родителя: одиночный шумный замер не делает лидером


# ───────────────────────── MCTS (UCT) ─────────────────────────
def new_node():
    return {"n": 0, "w": 0.0, "ch": {}}


def k(v):
    return json.dumps(v)


def mean(nd):
    return nd["w"] / nd["n"] if nd["n"] else 0.0


def seed_tree():
    """Стартовая подсказка: путь по умолчанию с одним виртуальным посещением."""
    root = new_node()
    root["n"] = 1
    node = root
    for name in ORDER:
        ch = new_node()
        ch["n"], ch["w"] = 1, 0.3
        node["ch"][k(DEFAULT_PATH[name])] = ch
        node = ch
    return {"root": root, "episodes": 0}


def greedy_value(node, name):
    prior = mean(node)
    best, bm = None, -9.0
    for v in SPACE[name]:
        ch = node["ch"].get(k(v))
        if ch and ch["n"] > 0:
            m = (ch["w"] + SHRINK * prior) / (ch["n"] + SHRINK)
            if m > bm:
                best, bm = v, m
    return best


def incumbent(tree):
    """Лучший известный путь (жадный спуск); недостающее — значения по умолчанию."""
    node, path = tree["root"], {}
    for name in ORDER:
        v = greedy_value(node, name) if node else None
        if v is None:
            v, node = DEFAULT_PATH[name], None
        else:
            node = node["ch"][k(v)]
        path[name] = v
    return path


def choose(tree, t, rng):
    root = tree["root"]
    n_total = root["n"]
    inc = incumbent(tree)
    explore = n_total < t.get("warmup", 8) or rng.random() < t.get("explore_prob", 0.35)

    if not explore:  # exploit
        node, tl = root, 0
        for name in ORDER:
            ch = node["ch"].get(k(inc[name]))
            if not ch or ch["n"] == 0:
                break
            node, tl = ch, tl + 1
        return dict(inc), tl

    c = max(0.15, t.get("c", 0.7) * (1 - n_total / 300))
    path, tl, node = {}, 0, root
    for name in ORDER:
        vals = SPACE[name]
        unvisited = [v for v in vals if node["ch"].get(k(v), {}).get("n", 0) == 0]
        if unvisited:  # expansion
            path[name] = rng.choice(unvisited)
            tl += 1
            break
        ln_n = math.log(max(node["n"], 2))
        best = max(vals, key=lambda v: mean(node["ch"][k(v)]) + c * math.sqrt(ln_n / node["ch"][k(v)]["n"]))
        path[name] = best
        node = node["ch"][k(best)]
        tl += 1
    for name in ORDER:  # default policy
        path.setdefault(name, inc[name])
    return path, tl


def update(tree, path, tl, reward):
    node = tree["root"]
    node["n"] += 1
    node["w"] += reward
    for name in ORDER[:tl]:
        node = node["ch"].setdefault(k(path[name]), new_node())
        node["n"] += 1
        node["w"] += reward
    tree["episodes"] += 1


def load_trees():
    d = load_json(TREES)
    return d if d and "fam" in d else {"episodes": 0, "fam": {}}


def tree_for(trees, fam):
    t = trees["fam"].get(fam)
    if not t or "root" not in t:
        t = trees["fam"][fam] = seed_tree()
    return t


# ───────────────────────── награда ─────────────────────────
def fam_reward(fe, extra, t):
    """fe — события filter одного семейства; extra — recov_events, cited, cited_unseen."""
    raw = sum(e["raw"] for e in fe)
    out = sum(e["out"] for e in fe)
    saved = 1 - out / raw
    reruns = sum(c - 1 for c in collections.Counter(e.get("h") for e in fe if e.get("trunc")).values() if c > 1)
    recov = reruns + extra.get("recov_events", 0)
    bad_trunc = sum(1 for e in fe if e.get("trunc") and e.get("rc", 0) != 0)
    cited = extra.get("cited", 0)
    miss = extra.get("cited_unseen", 0) / cited if cited else 0.0
    reward = (saved - t["recovery_penalty"] * recov - t["fail_trunc_penalty"] * bad_trunc
              - t["miss_penalty"] * miss)
    reward = max(-1.0, min(1.0, reward))
    (pj, tl), _ = collections.Counter(
        (json.dumps(e["path"], sort_keys=True), e.get("tl", 0)) for e in fe).most_common(1)[0]
    return reward, {"path": json.loads(pj), "tl": tl, "saved": round(saved, 3), "recov": recov,
                    "miss": round(miss, 3), "raw": raw, "reward": round(reward, 3)}


# ───────────────────────── метки и обучение модели строк ─────────────────────────
def _read_log(path):
    try:
        return Path(path).read_text(encoding="utf-8").splitlines()[:20000]
    except OSError:
        return None


def analyze_logs(ep, entries, cfg, model, rng, deadline):
    """Размечает сохранённые логи по поведению Claude, учит модель. -> (agg по семействам, статистика)."""
    agg = collections.defaultdict(lambda: {"cited": 0, "cited_unseen": 0})
    st = {"logs": 0, "model_recall": [], "regex_recall": []}
    sc = cfg["scorer"]
    trunc = [e for e in ep if e.get("kind") == "filter" and e.get("trunc") and e.get("log")][:8]
    for e in trunc:
        lines = _read_log(e["log"])
        if lines is None:
            continue
        texts, cmds = labels.after(entries, e["ts"])
        if not texts:
            continue
        fam = e.get("fam", "other")
        pos = labels.cited_lines(lines, labels.distinctive(texts)) | \
            labels.command_labels(cmds, Path(e["log"]).name, lines)
        total, hn, tn = len(lines), e.get("hn", 0), e.get("tn", 0)
        shown = set(range(hn)) | set(range(max(0, total - tn), total)) | {i - 1 for i in e.get("rescued", [])}
        agg[fam]["cited"] += len(pos)
        agg[fam]["cited_unseen"] += len(pos - shown)
        st["logs"] += 1
        if sc.get("enabled", True):
            cap = (e.get("path") or {}).get("salient_cap") or 30
            r = scorer.recall_at_cap(model, lines, hn, total - tn, pos, cap, fam, sc["threshold_mult"])
            if r:
                st["model_recall"].append(r[0])
                st["regex_recall"].append(r[1])
            model.train_log(lines, pos, fam, rng, deadline)
            model.meta["logs"] += 1
    for key, vals in (("ema_model_recall", st["model_recall"]), ("ema_regex_recall", st["regex_recall"])):
        if vals:
            model.meta[key] = round(0.8 * model.meta[key] + 0.2 * (sum(vals) / len(vals)), 4)
    return agg, st


def teacher_step(ep, cfg, model, rng, sid, deadline):
    """Haiku размечает один лог; модель-ученик учится у него. Доля вызовов падает с согласием."""
    h = cfg["haiku"]
    if INNER or not h.get("enabled"):
        return None
    if rng.random() >= max(0.02, h["teacher_prob"] * (1 - model.meta.get("agree", 0.0))):
        return None
    cands = [e for e in ep if e.get("kind") == "filter" and e.get("trunc") and e.get("log")]
    if not cands:
        return None
    e = max(cands, key=lambda x: x["raw"])
    lines = _read_log(e["log"])
    fam = e.get("fam", "other")
    if not lines:
        return None
    a, b = e.get("hn", 0), len(lines) - e.get("tn", 0)
    if b - a < 20:
        return None
    stu = model.top_lines(lines, a, b, 150, fam, 0.0)
    rest = [i for i in range(a, b) if i not in set(stu)]
    pick = sorted(set(stu) | set(rng.sample(rest, min(150, len(rest)))))
    ans = haiku.label(cfg, sid, [(i + 1, lines[i]) for i in pick])
    if ans is None:
        return None
    truth = {n - 1 for n in ans if (n - 1) in set(pick)}
    agree = scorer.f1(model.top_lines(lines, a, b, max(1, len(truth)), fam, 0.0), truth)
    model.meta["agree"] = round(0.7 * model.meta.get("agree", 0.0) + 0.3 * agree, 4)
    n = len(lines)
    for i in pick:
        if time.time() > deadline:
            break
        model.update(scorer.features(lines[i], i / n, fam), 1 if i in truth else 0, 2.0)
    return {"labeled": len(pick), "positives": len(truth), "agree": round(agree, 3)}


# ───────────────────────── Stop ─────────────────────────
def process_stop(sid, transcript_path="", rng=None):
    if INNER:
        return {}
    rng = rng or random.Random()
    t0 = time.time()
    info = {}
    with lock():
        evs = read_events()
        last = max((i for i, e in enumerate(evs) if e.get("kind") == "stop" and e.get("sid") == sid), default=-1)
        ep = [e for e in evs[last + 1:] if e.get("sid") == sid]
        cfg = load_config()
        entries, usage = labels.parse_transcript(transcript_path) if transcript_path else ([], None)

        # 1-2. метки, модель строк, учитель
        model = scorer.load()
        agg, lstats = analyze_logs(ep, entries, cfg, model, rng, t0 + cfg["scorer"]["train_budget_s"])
        tinfo = teacher_step(ep, cfg, model, rng, sid, t0 + cfg["scorer"]["train_budget_s"] + 3)
        if lstats["logs"] or tinfo:
            model.save()
            info["scorer"] = {"logs": lstats["logs"], "n_pos": model.n_pos, "teacher": tinfo,
                              "recall_model": model.meta["ema_model_recall"],
                              "recall_regex": model.meta["ema_regex_recall"]}

        # 3. MCTS по семействам
        t = cfg["tuner"]
        by_fam = collections.defaultdict(list)
        for e in ep:
            if e.get("kind") == "filter" and e.get("raw", 0) >= t["min_raw_chars"]:
                by_fam[e.get("fam", "other")].append(e)
        recov = collections.Counter(e.get("fam", "other") for e in ep if e.get("kind") == "recovery")
        if t["enabled"] and by_fam:
            trees = load_trees()
            for fam, fe in by_fam.items():
                extra = {"recov_events": recov[fam], **agg.get(fam, {})}
                reward, finfo = fam_reward(fe, extra, t)
                tree = tree_for(trees, fam)
                update(tree, finfo["path"], finfo["tl"], reward)
                trees["episodes"] += 1
                cfg["paths"][fam], cfg["tls"][fam] = choose(tree, t, rng)
                info.setdefault("fam", {})[fam] = finfo
            save_json(TREES, trees)
            save_json(CONFIG, cfg)

        # 4. прогноз контекста
        cinfo = ctxpred.update(sid, labels.context_tokens(usage),
                               [sum(e.get("out", 0) for e in ep if e.get("kind") == "filter") / 4000.0,
                                sum(1 for e in ep if e.get("kind") == "filter")], cfg)
        if cinfo:
            info["ctx"] = {k_: v for k_, v in cinfo.items() if k_ != "msg"}
        append_event({"kind": "stop", "sid": sid, "ts": time.time(), "ep": info})
        rotate_events()
    return {"info": info, "msg": cinfo["msg"] if cinfo else None}


# ───────────────────────── CLI ─────────────────────────
def status():
    cfg = load_config()
    trees = load_trees()
    print(f"episodes: {trees['episodes']} | tuner: {'on' if cfg['tuner']['enabled'] else 'frozen'}")
    print("default path:", json.dumps(cfg["path"]))
    for fam, tree in sorted(trees["fam"].items(), key=lambda kv: -kv[1]["root"]["n"]):
        print(f"  {fam:8s} n={tree['episodes']:3d}  now={json.dumps(cfg['paths'].get(fam, cfg['path']))}")
    if trees["fam"]:
        fam, tree = max(trees["fam"].items(), key=lambda kv: kv[1]["root"]["n"])
        print(f"arms for '{fam}':")
        node = tree["root"]
        for name in ORDER:
            cells = []
            for v in SPACE[name]:
                ch = node["ch"].get(k(v))
                cells.append(f"{v}: n={ch['n']} mu={mean(ch):+.2f}" if ch and ch["n"] else f"{v}: -")
            print(f"    {name:12s} | " + " | ".join(cells))
            v = greedy_value(node, name)
            if v is None:
                break
            node = node["ch"][k(v)]
    m = scorer.load()
    mode = "model" if m.n_pos >= cfg["scorer"]["min_pos"] else f"regexp (need {cfg['scorer']['min_pos']} labels)"
    print(f"scorer: {mode} | labels={m.n_pos} logs={m.meta['logs']} "
          f"recall model/regex={m.meta['ema_model_recall']:.2f}/{m.meta['ema_regex_recall']:.2f} "
          f"agree-with-haiku={m.meta['agree']:.2f}")
    b = load_json(Path(__file__).resolve().parent / "state" / "budget.json", {"total": {"calls": 0, "tokens": 0}})
    h = cfg["haiku"]
    print(f"haiku: {'on' if h['enabled'] else 'off'} ({h['backend']}) | calls={b['total']['calls']} "
          f"~tokens={b['total']['tokens']}")


def set_cfg(fn):
    with lock():
        cfg = load_config()
        fn(cfg)
        save_json(CONFIG, cfg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--freeze", action="store_true")
    ap.add_argument("--unfreeze", action="store_true")
    ap.add_argument("--haiku", choices=["on", "off"])
    a = ap.parse_args()
    if a.status:
        return status()
    if a.freeze or a.unfreeze:
        return set_cfg(lambda c: c["tuner"].update(enabled=a.unfreeze))
    if a.haiku:
        return set_cfg(lambda c: c["haiku"].update(enabled=a.haiku == "on"))
    if a.reset:
        def reset(c):
            c["path"], c["tl"], c["paths"], c["tls"] = dict(DEFAULT_PATH), 0, {}, {}
        set_cfg(reset)
        save_json(TREES, {"episodes": 0, "fam": {}})
        return print("trees reset (модель строк и бюджет Haiku не тронуты)")
    if INNER:
        return
    try:  # режим хука
        data = json.load(sys.stdin)
        res = process_stop(str(data.get("session_id", "")), str(data.get("transcript_path", "") or ""))
        if res.get("msg"):
            print(json.dumps({"systemMessage": res["msg"]}, ensure_ascii=False))
    except Exception:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
