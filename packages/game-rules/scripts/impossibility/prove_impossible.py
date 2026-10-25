#!/usr/bin/env python3
"""
Доказательство, что полный перебор партии «Рыцари и Замки» невозможен.

Компилирует perft.cpp (C++, все ядра) и перебирает ВСЕ ветки со стартовой
позиции — глубина за глубиной, с живым прогрессом. Затем по измеренным
числам считает, сколько займёт перебор до самой ранней возможной победы.

C++ модель — подмножество игры (только перемещения + лимит 3 юнита за ход +
конец хода). Настоящее дерево больше, поэтому все оценки — нижние границы:
реальность хуже.

Запуск:  python3 prove_impossible.py [макс_глубина] [потоки]
         (по умолчанию глубина 7; Ctrl+C — остановить и получить вывод)
"""
import math
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "perft.cpp")
BIN = os.path.join(HERE, "perft")

UNIVERSE_AGE_S = 4.35e17          # 13,8 млрд лет
ALL_EARTH_PER_S = 1e18            # щедро: все процессоры и GPU Земли вместе
YEAR = 3.156e7

# Самая ранняя победа, какая вообще возможна (нижняя граница длины партии):
# лучник стартует в ряду 0, вражеский замок начинается с ряда 16 — 16 клеток;
# лучник проходит максимум 3 клетки за ход → ≥ 6 своих ходов, между ними
# ≥ 5 «конец хода» своих и ≥ 5 у соперника. 6 + 5 + 5 = 16 действий.
# (И это при соперничестве в поддавки: на деле победа в десятки раз дальше.)
MIN_WIN_DEPTH = 16
# Если соперник ЗАЩИЩАЕТСЯ (держит 11 юнитов в замке), победителю нужно дойти
# (≥ 5 своих ходов) и перебить всех защитников — за ход можно задействовать
# только 3 юнита, так что это ещё ≥ 4 хода. ~9 своих ходов по ≥ 3 действия +
# ходы соперника ≈ 40 действий. Решение обязано проверить и такие ветки.
DEFENDED_DEPTH = 40
REALISTIC_DEPTH = 300             # обычная партия: ~40 ходов × ~7 действий


def human_time(sec: float) -> str:
    """sec may be a float or a log10 value wrapped as ('log', x)."""
    if isinstance(sec, tuple):
        lg = sec[1] - math.log10(YEAR)
        return f"10^{lg:.0f} лет" if lg >= 6 else human_time(10 ** sec[1])
    if sec < 60:
        return f"{sec:.1f} с"
    if sec < 3600:
        return f"{sec / 60:.1f} мин"
    if sec < 86400:
        return f"{sec / 3600:.1f} ч"
    years = sec / YEAR
    if years < 1:
        return f"{sec / 86400:.1f} дн"
    if years < 1e6:
        return f"{years:,.0f} лет".replace(",", " ")
    return f"10^{math.log10(years):.0f} лет"


def big(n) -> str:
    if isinstance(n, tuple):
        e = math.floor(n[1])
        return f"{10 ** (n[1] - e):.2f}·10^{e}"
    if n < 1e6:
        return f"{n:,.0f}".replace(",", " ")
    return f"{n / 10 ** int(math.log10(n)):.2f}·10^{int(math.log10(n))}"


def bar(frac: float, width: int = 30) -> str:
    full = int(frac * width)
    return "█" * full + "░" * (width - full)


def build() -> None:
    if os.path.exists(BIN) and os.path.getmtime(BIN) >= os.path.getmtime(SRC):
        return
    cxx = shutil.which("g++") or shutil.which("clang++")
    if not cxx:
        sys.exit("Нужен компилятор C++ (g++ или clang++).")
    print("Компилирую C++ (-O3, все ядра)…")
    subprocess.run([cxx, "-O3", "-march=native", "-pthread", SRC, "-o", BIN], check=True)


def main() -> None:
    max_depth = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    threads = sys.argv[2] if len(sys.argv) > 2 else str(os.cpu_count() or 1)
    build()
    print(f"Перебираю ВСЕ ветки со стартовой позиции: 22 юнита, поле 20×20, потоков {threads}.\n")

    results = []  # (depth, branches, seconds)
    proc = subprocess.Popen([BIN, str(max_depth), threads], stdout=subprocess.PIPE, text=True)
    start = time.time()
    try:
        for line in proc.stdout:
            p = line.split()
            if p[0] == "PROGRESS":
                d, done, total, nodes, sec = int(p[1]), int(p[2]), int(p[3]), int(p[4]), float(p[5])
                rate = nodes / max(sec, 1e-9)
                sys.stdout.write(
                    f"\r  глубина {d:2d} {bar(done / total)} {done}/{total} веток первого хода | "
                    f"{big(nodes)} узлов | {big(rate)}/с    "
                )
                sys.stdout.flush()
            elif p[0] == "DEPTH":
                d, n, sec = int(p[1]), int(p[2]), float(p[3])
                results.append((d, n, sec))
                b = n / results[-2][1] if len(results) > 1 else n
                sys.stdout.write("\r" + " " * 110 + "\r")
                print(f"  глубина {d:2d}: {big(n):>14} веток   (×{b:5.1f} к прошлой)   готово за {human_time(sec)}")
    except KeyboardInterrupt:
        proc.kill()
        print("\n  остановлено.")
    proc.wait()

    if len(results) < 3:
        print("Нужно хотя бы 3 глубины для вывода.")
        return

    d_last, n_last, _ = results[-1]
    # Скорость: ветки последней глубины / время её прохода.
    t_last = results[-1][2] - results[-2][2]
    rate = n_last / max(t_last, 1e-9)
    # Коэффициент ветвления: среднее геометрическое по последним глубинам.
    tail = results[-3:]
    b = (tail[-1][1] / tail[0][1]) ** (1 / (len(tail) - 1))

    def log_at(depth: int) -> float:
        return math.log10(n_last) + (depth - d_last) * math.log10(b)

    def at(depth: int):
        return ("log", log_at(depth))

    def over(lg_n: float, per_s: float):
        return ("log", lg_n - math.log10(per_s))

    print("\n" + "═" * 78)
    print("ДОКАЗАТЕЛЬСТВО")
    print("═" * 78)
    print(f"Измерено: каждое следующее действие умножает число веток в {b:.1f} раза.")
    print(f"Скорость этого компьютера: {big(rate)} веток/с (C++, {threads} потоков).\n")
    print(f"{'Глубина (действий)':<26}{'Веток (минимум)':>18}{'Этот компьютер':>18}{'Все ПК Земли':>16}")
    for depth, label in [
        (d_last + 2, f"{d_last + 2}"),
        (MIN_WIN_DEPTH, f"{MIN_WIN_DEPTH} — победа в поддавки"),
        (DEFENDED_DEPTH, f"{DEFENDED_DEPTH} — соперник защищается"),
        (REALISTIC_DEPTH, f"{REALISTIC_DEPTH} — обычная партия"),
    ]:
        lg = log_at(depth)
        print(f"{label:<26}{big(at(depth)):>18}{human_time(over(lg, rate)):>18}{human_time(over(lg, ALL_EARTH_PER_S)):>16}")

    lg_def = log_at(DEFENDED_DEPTH) - math.log10(ALL_EARTH_PER_S)
    times_universe = lg_def - math.log10(UNIVERSE_AGE_S)
    print(f"\nВозраст Вселенной: {human_time(UNIVERSE_AGE_S)}.")
    print(
        f"Чтобы ДОКАЗАТЬ исход, нужно проверить и ветки, где соперник защищается\n"
        f"(≈{DEFENDED_DEPTH} действий): все компьютеры Земли считали бы их в 10^{times_universe:.0f} раз\n"
        f"дольше, чем существует Вселенная. Быстрая победа на {MIN_WIN_DEPTH} действий есть только\n"
        f"в поддавки — решатель не имеет права на неё рассчитывать."
    )
    print(
        "\nИ это НИЖНЯЯ граница: здесь нет атак, способностей мага, крафта и стройки —\n"
        "с ними веток ещё больше. А ветки, где юниты ходят туда-сюда, не кончаются\n"
        "вообще никогда: «перебрать до победы» для них невозможно даже за бесконечное время."
    )
    print("\nВывод: полный перебор партии невозможен на любом существующем или мыслимом железе. ∎")


if __name__ == "__main__":
    main()
