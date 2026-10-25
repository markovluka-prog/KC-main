#!/usr/bin/env python3
"""
Полный перебор партии «Рыцари и Замки» со стартовой позиции — с прогрессом.

Запускает решатель на НАСТОЯЩИХ правилах (scripts/solve.mjs: все ходы, атаки,
способности мага, крафт, стройка, конец хода; все ядра; таблица позиций;
отсечение по доказательству) и показывает, как он продвигается:

  глубина 6  ███████████░░░░░░░░░  55%  | 12.4 млн поз. | 1.4 млн/с | осталось ~9 мин

Глубина = сколько действий вперёд уже проверено целиком. Перебор идёт, пока
не найдена форсированная победа (тогда печатается лучший первый ход) или пока
ты не нажмёшь Ctrl+C. Итоги каждой глубины пишутся в run_full_search.log.

Запуск (из packages/game-rules):
    python3 scripts/run_full_search.py            # карта seed 1
    python3 scripts/run_full_search.py --seed 7
"""
import json
import math
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
LOG = os.path.join(HERE, "run_full_search.log")


def fmt(n: float) -> str:
    for lim, suf in ((1e12, " трлн"), (1e9, " млрд"), (1e6, " млн"), (1e3, " тыс")):
        if n >= lim:
            return f"{n / lim:.2f}{suf}"
    return f"{n:.0f}"


def dur(sec: float) -> str:
    if sec < 60:
        return f"{sec:.0f} с"
    if sec < 3600:
        return f"{sec / 60:.0f} мин"
    if sec < 86400:
        return f"{sec / 3600:.1f} ч"
    days = sec / 86400
    if days < 365:
        return f"{days:.0f} дн"
    years = days / 365.25
    return f"{years:,.0f} лет".replace(",", " ") if years < 1e6 else f"10^{math.log10(years):.0f} лет"


def bar(frac: float, width: int = 24) -> str:
    frac = max(0.0, min(1.0, frac))
    n = int(frac * width)
    return "█" * n + "░" * (width - n)


def main() -> None:
    extra = sys.argv[1:]
    print("Сборка движка правил…")
    subprocess.run(["npx", "tsc"], cwd=PKG, check=True)
    cmd = ["node", "--max-old-space-size=12000", os.path.join(HERE, "solve.mjs"), "--json", *extra]
    proc = subprocess.Popen(cmd, cwd=PKG, stdout=subprocess.PIPE, text=True)

    depth_nodes = {}  # depth → cumulative node count when that depth finished
    depth_secs = {}
    start = time.time()
    with open(LOG, "a", encoding="utf-8") as log:
        log.write(f"\n=== старт {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(extra)} ===\n")
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line.startswith("{"):
                    if line:
                        print(f"\r{' ' * 100}\r{line}")
                    continue
                m = json.loads(line)
                if m["t"] == "progress" and m["depth"]:
                    d = m["depth"]
                    nodes, sec = m["nodes"], m["sec"]
                    rate = nodes / max(sec, 1e-9)
                    base = depth_nodes.get(d - 1, 0)
                    here = nodes - base
                    # Expected size of this depth from the growth seen so far.
                    est = None
                    if d - 1 in depth_nodes and d - 2 in depth_nodes:
                        prev = depth_nodes[d - 1] - depth_nodes.get(d - 2, 0)
                        prev2 = depth_nodes[d - 2] - depth_nodes.get(d - 3, 0)
                        growth = prev / max(prev2, 1)
                        est = prev * growth
                    frac = here / est if est else m["done"] / max(m["total"], 1)
                    eta = (est - here) / max(rate, 1) if est and est > here else None
                    sys.stdout.write(
                        f"\r  глубина {d:2d}  {bar(frac)} {min(frac, 0.99) * 100:3.0f}%"
                        f"  | {fmt(here)} поз. | {fmt(rate)}/с"
                        f"  | идёт {dur(time.time() - start)}"
                        + (f" | осталось ~{dur(eta)}" if eta else "")
                        + "     "
                    )
                    sys.stdout.flush()
                elif m["t"] == "depth":
                    d = m["depth"]
                    depth_nodes[d] = m["nodes"]
                    depth_secs[d] = m["sec"]
                    size = m["nodes"] - depth_nodes.get(d - 1, 0)
                    growth = size / max(depth_nodes.get(d - 1, 0) - depth_nodes.get(d - 2, 0), 1) if d > 1 else size
                    msg = (
                        f"глубина {d:2d} пройдена целиком: {fmt(size)} позиций (×{growth:.1f}), "
                        f"всего {dur(m['sec'])}"
                        + (f" — РЕШЕНО: побеждает {m['result']}" if m["result"] else " — победа не найдена, углубляюсь")
                    )
                    print(f"\r{' ' * 110}\r  {msg}")
                    log.write(msg + "\n")
                    log.flush()
                    if not m["result"] and d >= 3:
                        # Where this is heading, at the speed measured right now.
                        rate = m["nodes"] / max(m["sec"], 1e-9)
                        lg = math.log10(max(size, 1)) + (40 - d) * math.log10(max(growth, 1.01))
                        if lg < 300:
                            print(f"     (с такой скоростью глубина 40 займёт ~{dur(10 ** lg / rate)})")
        except KeyboardInterrupt:
            proc.terminate()
            print("\nОстановлено. Итоги — в", LOG)
    proc.wait()


if __name__ == "__main__":
    main()
