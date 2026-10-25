"""Предсказание раздувания контекста и предупреждение «пора /compact».

Хук не может сам выполнить /compact, поэтому мы предупреждаем пользователя (systemMessage).
Модель: онлайн-линейная регрессия (NLMS) прироста контекста за ход от объёма вывода
инструментов и числа вызовов. Прогноз -> «через сколько ходов упрёмся в порог».
"""
import time

from common import CTXFILE, load_json, save_json

KEEP_SESSIONS = 20


def _dot(w, x):
    return sum(a * b for a, b in zip(w, x))


def update(sid, ctx, feats, cfg):
    """ctx — токенов в контексте сейчас; feats — [ktok вывода инструментов за ход, число вызовов].
    Возвращает dict(msg=str|None, pred=k-токенов/ход, err=...)"""
    c = cfg["ctx"]
    if not c.get("enabled", True) or not ctx:
        return None
    state = load_json(CTXFILE, {"w": [0.5, 1.0, 0.1], "sessions": {}})
    s = state["sessions"].setdefault(sid, {"ctx": None, "turns": 0, "ef": [0.0, 0.0], "last_alert": -999, "n": 0})
    window = c["window"] if ctx <= c["window"] else 1_000_000
    thr = c["soft_frac"] * window
    x = [1.0] + [float(v) for v in feats]
    err = None
    if s["ctx"] is not None:
        d = (ctx - s["ctx"]) / 1000.0
        if d < -0.2 * s["ctx"] / 1000.0:       # контекст сжали — старая траектория не годится
            s["ef"] = [0.0, 0.0]
        else:
            pred_now = _dot(state["w"], x)
            err = d - pred_now
            mu = 0.3 / (1e-6 + _dot(x, x))      # NLMS
            state["w"] = [w + mu * err * xi for w, xi in zip(state["w"], x)]
            s["n"] += 1
    a = 0.3
    s["ef"] = [(1 - a) * e + a * f for e, f in zip(s["ef"], feats)] if s["turns"] else [float(f) for f in feats]
    s["turns"] += 1
    s["ctx"] = ctx
    pred = max(0.2, _dot(state["w"], [1.0] + s["ef"]))   # k-токенов за следующий ход
    turns_left = 0.0 if ctx >= thr else (thr - ctx) / 1000.0 / pred
    msg = None
    cooled = s["turns"] - s["last_alert"] >= c["cooldown_turns"]
    if cooled and (ctx >= thr or turns_left <= c["warn_turns"]):
        s["last_alert"] = s["turns"]
        pct = int(100 * ctx / window)
        if ctx >= thr:
            msg = (f"token-saver: контекст ~{ctx // 1000}k токенов ({pct}% окна), порог {int(thr) // 1000}k пройден. "
                   f"Хороший момент для /compact или нового чата.")
        else:
            msg = (f"token-saver: контекст ~{ctx // 1000}k токенов ({pct}% окна), прогноз роста "
                   f"~{pred:.0f}k за ход: порог {int(thr) // 1000}k примерно через {max(1, round(turns_left))} ходов. "
                   f"Лучше сделать /compact на ближайшей паузе.")
    # хранить только свежие сессии
    if len(state["sessions"]) > KEEP_SESSIONS:
        for k in sorted(state["sessions"], key=lambda k: state["sessions"][k].get("ts", 0))[:-KEEP_SESSIONS]:
            del state["sessions"][k]
    s["ts"] = time.time()
    save_json(CTXFILE, state)
    return {"msg": msg, "pred": round(pred, 2), "err": None if err is None else round(err, 2),
            "turns_left": round(turns_left, 1)}
