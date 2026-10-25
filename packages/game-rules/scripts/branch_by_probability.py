#!/usr/bin/env python3
"""
Ветка партии под заданную вероятность победы.

Ты задаёшь вероятность (например 0.7) и игрока. Программа строит ОДНУ ветку
от стартовой позиции до конца партии, на каждом шаге выбирая ход, после
которого вероятность победы этого игрока ближе всего к заданной.

Вероятность позиции = доля веток дерева под ней, кончающихся победой игрока.
Точно её не посчитать (дерево бесконечное), поэтому она оценивается
случайной выборкой веток до конца партии (метод Монте-Карло), на всех ядрах.

Запуск (из packages/game-rules):
    python3 scripts/branch_by_probability.py 0.7 --player 1
    python3 scripts/branch_by_probability.py 0.3 --player 2 --samples 24 --candidates 12
Параметры точности: --samples (веток на оценку, по умолч. 12),
                   --candidates (сколько ходов сравнивать на шаге, по умолч. 8).
Больше — точнее, но медленнее. Ctrl+C — остановить; уже построенная часть
ветки сохраняется.

Результат: scripts/branch_<вероятность>_p<игрок>.txt (читаемо) и .json (всё).
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)


def describe(a: dict) -> str:
    k = a.get("kind")
    u = a.get("unitId", "?")
    if k == "end-turn":
        return "конец хода"
    if k == "move":
        return f"юнит {u} идёт на ({a['row']},{a['col']})"
    if k == "attack":
        return f"юнит {u} атакует ({a['targetRow']},{a['targetCol']})"
    if k == "mage-attack":
        return f"маг {u} бьёт ({a['targetRow']},{a['targetCol']}) на {a['damage']}"
    if k == "mage-heal":
        return f"маг {u} лечит юнита {a['targetUnitId']}"
    if k == "mage-drain":
        return f"маг {u} высасывает юнита {a['targetUnitId']}"
    if k == "mage-ward":
        return f"маг {u} щит на {a['toggleUnitIds']}"
    if k == "mage-burn-bridge":
        return f"маг {u} жжёт мост ({a['row']},{a['col']})"
    if k in ("build-tower", "build-bridge"):
        return f"рыцарь {u} строит {'башню' if k == 'build-tower' else 'мост'} ({a['row']},{a['col']})"
    if k == "craft":
        return f"юнит {u} крафтит оружие #{a['index']}"
    if k == "craft-armor":
        return f"юнит {u} крафтит броню #{a['index']}"
    if k == "castle-heal":
        return f"юнит {u} лечится в замке"
    return f"{k} юнит {u}"


def dur(sec: float) -> str:
    if sec < 60:
        return f"{sec:.0f} с"
    if sec < 3600:
        return f"{sec / 60:.0f} мин"
    return f"{sec / 3600:.1f} ч"


def bar(p: float, target: float, width: int = 30) -> str:
    cells = ["░"] * width
    t = min(width - 1, int(target * width))
    cells[t] = "│"
    pos = min(width - 1, int(p * width))
    cells[pos] = "●"
    return "".join(cells)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    target = float(sys.argv[1])
    if not 0 <= target <= 1:
        sys.exit("Вероятность — число от 0 до 1, например 0.7")
    rest = sys.argv[2:]
    player = "1"
    if "--player" in rest:
        player = rest[rest.index("--player") + 1]
    print("Сборка движка правил…")
    subprocess.run(["npx", "tsc"], cwd=PKG, check=True)
    cmd = ["node", "--max-old-space-size=8000", os.path.join(HERE, "prob-branch.mjs"), "--target", str(target), *rest]
    if "--player" not in rest:
        cmd += ["--player", player]
    proc = subprocess.Popen(cmd, cwd=PKG, stdout=subprocess.PIPE, text=True)

    base = os.path.join(HERE, f"branch_{target}_p{player}")
    steps = []
    start_prob = None
    t0 = time.time()

    def save(final=None):
        with open(base + ".json", "w", encoding="utf-8") as f:
            json.dump({"target": target, "player": int(player), "startProb": start_prob, "steps": steps, "end": final}, f, ensure_ascii=False)
        with open(base + ".txt", "w", encoding="utf-8") as f:
            f.write(f"Цель: вероятность победы игрока {player} = {target:.0%}\n")
            if start_prob is not None:
                f.write(f"На старте: {start_prob:.0%}\n\n")
            for s in steps:
                f.write(f"{s['step']:6d}. {describe(s['action']):<45} вероятность {s['prob']:.0%}\n")
            if final:
                f.write(f"\nКонец партии: победил игрок {final['winner']} за {final['length']} действий.\n")

    try:
        for line in proc.stdout:
            if not line.startswith("{"):
                continue
            m = json.loads(line)
            if m["t"] == "start":
                print(
                    f"Цель: вероятность победы игрока {m['player']} = {m['target']:.0%}. "
                    f"Оценка: {m['samples']} случайных веток на ход, потоков {m['workers']}.\n"
                )
            elif m["t"] == "startProb":
                start_prob = m["prob"]
                print(f"  На старте вероятность ≈ {start_prob:.0%}\n")
            elif m["t"] == "step":
                steps.append(m)
                avg = m["sec"] / m["step"]
                sys.stdout.write(
                    f"\r  шаг {m['step']:5d} | {bar(m['prob'], target)} {m['prob']:4.0%} (цель {target:.0%}) "
                    f"| {describe(m['action'])[:34]:<34} | {avg:.1f} с/шаг | идёт {dur(time.time() - t0)}   "
                )
                sys.stdout.flush()
                if m["step"] % 25 == 0:
                    save()
            elif m["t"] == "end":
                save(m)
                print(f"\n\n✅ Ветка построена: {m['length']} действий, победил игрок {m['winner']}, за {dur(m['sec'])}.")
                near = sum(1 for s in steps if abs(s["prob"] - target) <= 0.1)
                print(f"   Вероятность держалась в пределах ±10% от цели на {near / max(len(steps), 1):.0%} шагов.")
                print(f"   Ветка целиком: {base}.txt")
    except KeyboardInterrupt:
        proc.terminate()
        save()
        print(f"\n\nОстановлено на шаге {len(steps)}. Построенная часть ветки: {base}.txt")
    proc.wait()


if __name__ == "__main__":
    main()
