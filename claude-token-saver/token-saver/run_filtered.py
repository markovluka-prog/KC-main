#!/usr/bin/env python3
"""Запускает команду, сжимает вывод, сохраняет полный лог, возвращает тот же код выхода.

Параметры читаются из config.json В МОМЕНТ запуска (свои для каждого семейства команд) —
поэтому тюнер меняет поведение «на ходу». Какие строки спасать из скрытой середины, решает
самообучающаяся модель (scorer.py), пока она не набрала данных — regexp. Для огромных выводов
при включённом Haiku добавляется дайджест скрытой части.
"""
import argparse
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (FAMILIES, INNER, LOGS, SALIENT, append_event, load_config,  # noqa: E402
                    path_for, tl_for)

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
LINE_CAP = 500


def collapse_runs(lines):
    res, i = [], 0
    while i < len(lines):
        j = i
        while j + 1 < len(lines) and lines[j + 1] == lines[i]:
            j += 1
        n = j - i + 1
        if n >= 3 and lines[i]:
            res.append(f"{lines[i]}  [x{n}]")
        else:
            res.extend(lines[i:j + 1])
        i = j + 1
    return res


def clean(text, collapse):
    """ANSI-коды, прогресс-бары (\\r), двойные пустые строки, повторы — безопасный шум."""
    text = ANSI.sub("", text).replace("\r\n", "\n")
    lines = []
    for ln in text.split("\n"):
        if "\r" in ln:
            parts = [p for p in ln.split("\r") if p.strip()]
            ln = parts[-1] if parts else ""
        lines.append(ln.rstrip())
    out, blank = [], False
    for ln in lines:
        if not ln:
            if blank:
                continue
            blank = True
        else:
            blank = False
        out.append(ln)
    if collapse:
        out = collapse_runs(out)
    while out and not out[-1]:
        out.pop()
    return out


def shorten(ln):
    if len(ln) > LINE_CAP:
        return ln[:LINE_CAP] + f" …[+{len(ln) - LINE_CAP} chars]"
    return ln


def pick_salient(lines, a, b, cap, fam, cfg):
    """Индексы строк скрытой части [a, b), которые стоит показать."""
    sc = cfg.get("scorer", {})
    if sc.get("enabled", True):
        try:
            import scorer
            m = scorer.load()
            if m.n_pos >= sc.get("min_pos", 20):
                return m.top_lines(lines, a, b, cap, fam, sc.get("threshold_mult", 1.5))
        except Exception:
            pass
    sal = [i for i in range(a, b) if SALIENT.search(lines[i])]
    if len(sal) > cap:  # поровну из начала и конца скрытой части
        sal = sal[: cap // 2] + sal[-(cap - cap // 2):]
    return sal


def try_digest(cfg, sid, middle, raw_len):
    h = cfg.get("haiku", {})
    if INNER or not h.get("enabled") or raw_len < h.get("digest_min_chars", 32000):
        return None
    try:
        import haiku
        return haiku.digest(cfg, sid, middle)
    except Exception:
        return None


def render(lines, p, log_path, fam, cfg, sid, raw_len):
    total, maxl = len(lines), p["max_lines"]
    if total <= maxl:
        return "\n".join(shorten(x) for x in lines), False, {}
    head_n = max(1, int(maxl * p["head_frac"]))
    tail_n = max(1, maxl - head_n)
    a, b = head_n, total - tail_n
    out = [shorten(x) for x in lines[:head_n]]
    out.append(
        f"[... {b - a} of {total} lines hidden; full output: {log_path} "
        f"(use grep -n / sed -n 'A,Bp' on it instead of re-running) ...]"
    )
    digest = try_digest(cfg, sid, lines[a:b], raw_len)
    if digest:
        out.append("[Haiku digest of the hidden part (may be imperfect; verify in the full log):]")
        out.extend(shorten(x) for x in digest)
        out.append("[... end digest ...]")
    sal = pick_salient(lines, a, b, p["salient_cap"], fam, cfg) if p["salient_cap"] else []
    if sal:
        out.append("[selected lines from the hidden part, as L<line in full output>:]")
        out.extend(f"L{i + 1}: {shorten(lines[i])}" for i in sal)
        out.append("[... end of hidden part ...]")
    out.extend(shorten(x) for x in lines[-tail_n:])
    meta = {"hn": head_n, "tn": tail_n, "lines": total, "rescued": [i + 1 for i in sal][:200],
            "digest": bool(digest)}
    return "\n".join(out), True, meta


def prune_logs(days=3):
    try:
        limit = time.time() - days * 86400
        for f in LOGS.glob("*.log"):
            if f.stat().st_mtime < limit:
                f.unlink()
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", default="")
    ap.add_argument("--fam", default="other")
    ap.add_argument("--h", default="")
    ap.add_argument("cmd")
    a = ap.parse_args()
    fam = a.fam if a.fam in FAMILIES else "other"

    cfg = load_config()
    shell = shutil.which("bash") or "/bin/sh"
    proc = subprocess.Popen([shell, "-c", a.cmd], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def forward(signum, _frame):
        try:
            proc.send_signal(signum)
        except Exception:
            pass

    for s in (signal.SIGTERM, signal.SIGINT):
        signal.signal(s, forward)

    data, _ = proc.communicate()
    raw = data.decode("utf-8", errors="replace")
    rc = proc.returncode
    if rc < 0:
        rc = 128 - rc

    p, tl = path_for(cfg, fam), tl_for(cfg, fam)
    out_text, truncated, meta, log_path = raw, False, {}, None
    if cfg.get("wrap_enabled", True):
        try:
            lines = clean(raw, p["collapse"])
            log_path = LOGS / f"{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}-{fam}-{(a.h or 'cmd')[:8]}.log"
            rendered, truncated, meta = render(lines, p, log_path, fam, cfg, a.sid, len(raw))
            if truncated:
                LOGS.mkdir(parents=True, exist_ok=True)
                log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            out_text = rendered
            prune_logs()
        except Exception:  # любой сбой фильтра -> отдаём вывод как есть
            out_text, truncated, meta, log_path = raw, False, {}, None

    if out_text and not out_text.endswith("\n"):
        out_text += "\n"
    sys.stdout.buffer.write(out_text.encode("utf-8", errors="replace"))
    sys.stdout.flush()

    try:
        append_event({
            "kind": "filter", "sid": a.sid, "ts": time.time(), "h": a.h, "fam": fam,
            "raw": len(raw), "out": len(out_text), "trunc": truncated, "rc": rc,
            "path": p, "tl": tl, "log": str(log_path) if truncated else None, **meta,
        })
    except OSError:
        pass
    sys.exit(rc)


if __name__ == "__main__":
    main()
