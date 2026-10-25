#!/usr/bin/env python3
"""
«Глубина = победа»: полный перебор партии со стартовой позиции, где КАЖДАЯ
ветка идёт вглубь, пока кто-то не победит. Без ограничения глубины.

Настоящие правила (все ходы, атаки, маг, крафт, стройка, конец хода), все
ядра. Ветку, которая вернулась в уже пройденную на этом же пути позицию,
программа обрывает как «цикл» — такая ветка не кончилась бы никогда.

На экране:
  ветки: P1 побед 12 | P2 побед 9 | циклов 3 401 | глубина 2 315 (макс 4 020)
  позиций 81.2 млн | 1.4 млн/с | ветки 1-го хода: 2/70 ████░░░░ | идёт 58 мин

Запуск (из packages/game-rules):
    python3 scripts/run_to_win.py              # Ctrl+C — остановить
    python3 scripts/run_to_win.py --seed 7
Итоги пишутся в scripts/run_to_win.log.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
LOG = os.path.join(HERE, "run_to_win.log")


def fmt(n: float) -> str:
    for lim, suf in ((1e12, " трлн"), (1e9, " млрд"), (1e6, " млн"), (1e3, " тыс")):
        if n >= lim:
            return f"{n / lim:.2f}{suf}"
    return f"{n:.0f}"


def num(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def dur(sec: float) -> str:
    if sec < 60:
        return f"{sec:.0f} с"
    if sec < 3600:
        return f"{sec / 60:.0f} мин"
    if sec < 86400:
        return f"{sec / 3600:.1f} ч"
    return f"{sec / 86400:.1f} дн"


def bar(frac: float, width: int = 12) -> str:
    n = int(max(0.0, min(1.0, frac)) * width)
    return "█" * n + "░" * (width - n)


def describe(a: dict) -> str:
    k = a.get("kind")
    if k == "end-turn":
        return "конец хода"
    if k == "move":
        return f"юнит {a['unitId']} → ({a['row']},{a['col']})"
    if k == "attack":
        return f"юнит {a['unitId']} бьёт ({a['targetRow']},{a['targetCol']})"
    return f"{k} юнит {a.get('unitId', '?')}"


def main() -> None:
    extra = sys.argv[1:]
    print("Сборка движка правил…")
    subprocess.run(["npx", "tsc"], cwd=PKG, check=True)
    proc = subprocess.Popen(
        # --max-semi-space-size: bigger young generation, fewer GC pauses (~5%).
        ["node", "--max-old-space-size=12000", "--max-semi-space-size=64", os.path.join(HERE, "dfs-to-win.mjs"), *extra],
        cwd=PKG, stdout=subprocess.PIPE, text=True,
    )
    with open(LOG, "a", encoding="utf-8") as log:
        log.write(f"\n=== старт {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(extra)} ===\n")
        try:
            for line in proc.stdout:
                if not line.startswith("{"):
                    continue
                m = json.loads(line)
                if m["t"] == "start":
                    print(
                        f"Старт: {m['units']} юнитов, {m['rootTotal']} вариантов первого действия, "
                        f"потоков {m['workers']}. Каждая ветка — до победы.\n"
                    )
                elif m["t"] == "progress":
                    rate = m["nodes"] / max(m["sec"], 1e-9)
                    sys.stdout.write(
                        f"\r  P1 побед {num(m['wins1'])} | P2 побед {num(m['wins2'])} | циклов {num(m['cycles'])}"
                        f" | глубина {num(m['depth'])} (макс {num(m['maxDepth'])})"
                        f" | {fmt(m['nodes'])} поз. {fmt(rate)}/с"
                        f" | отсечено {fmt(m['skipped'])} | повторов {fmt(m['merged'])}"
                        f" | 1-й ход {m['rootDone']}/{m['rootTotal']} {bar(m['rootDone'] / m['rootTotal'])}"
                        f" | {dur(m['sec'])}   "
                    )
                    sys.stdout.flush()
                    if int(m["sec"]) % 60 == 0:
                        log.write(json.dumps(m, ensure_ascii=False) + "\n")
                        log.flush()
                elif m["t"] == "firstWin":
                    steps = m["line"]
                    print(f"\r{' ' * 150}\r  ★ Первая победа найдена: игрок {m['winner']} за {m['length']} действий.")
                    print("    Начало цепочки: " + "; ".join(describe(a) for a in steps[:8]) + (" …" if len(steps) > 8 else ""))
                    log.write(f"первая победа: P{m['winner']} за {m['length']} действий\n")
                    log.flush()
                elif m["t"] == "solved":
                    who = f"игрок {m['winner']}"
                    print(f"\r{' ' * 160}\r\n  ✅ РЕШЕНО за {dur(m['sec'])}: при идеальной игре побеждает {who}.")
                    if m.get("firstAction"):
                        print(f"     Выигрывающий первый ход: {describe(m['firstAction'])}")
                    print(f"     Проверено {fmt(m['nodes'])} позиций, отсечено {fmt(m['skipped'])} лишних веток.")
                    log.write(f"РЕШЕНО: побеждает {who} ({json.dumps(m, ensure_ascii=False)})\n")
                elif m["t"] == "done":
                    word = "Остановлено" if m.get("stopped") else "ПЕРЕБОР ЗАВЕРШЁН"
                    summary = (
                        f"{word} за {dur(m['sec'])}: P1 побед {num(m['wins1'])}, P2 побед {num(m['wins2'])}, "
                        f"циклов {num(m['cycles'])}, позиций {fmt(m['nodes'])}, макс. глубина {num(m['maxDepth'])}"
                    )
                    print(f"\n{summary}")
                    log.write(summary + "\n")
        except KeyboardInterrupt:
            proc.send_signal(2)
            try:
                for line in proc.stdout:
                    if line.startswith("{") and '"done"' in line:
                        m = json.loads(line)
                        print(f"\nОстановлено: P1 побед {num(m['wins1'])}, P2 побед {num(m['wins2'])}, "
                              f"циклов {num(m['cycles'])}, позиций {fmt(m['nodes'])}, макс. глубина {num(m['maxDepth'])}")
                        break
            except KeyboardInterrupt:
                pass
    proc.wait()


if __name__ == "__main__":
    main()
