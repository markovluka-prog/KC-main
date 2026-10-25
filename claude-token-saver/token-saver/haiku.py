"""Вызовы Haiku из хуков: дайджест скрытой части вывода и «учитель» для локальной модели.

Три бэкенда: `claude_cli` (claude -p --model haiku, тратит лимит подписки), `api`
(ANTHROPIC_API_KEY, отдельная оплата), `cmd` (любая своя команда: prompt на stdin, ответ на stdout).
Жёсткие лимиты: вызовов на сессию, токенов на сессию, размер входа/выхода. Выключено по умолчанию.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import time
import urllib.request

from common import BUDGET, INNER, load_json, lock, save_json


def _state():
    return load_json(BUDGET, {"sessions": {}, "total": {"calls": 0, "tokens": 0}})


def est_tokens(*texts):
    return int(sum(len(t) for t in texts) / 3.5) + 1


def allowed(cfg, sid, est_in):
    h = cfg["haiku"]
    if INNER or not h.get("enabled"):
        return False
    s = _state()["sessions"].get(sid, {"calls": 0, "tokens": 0})
    return s["calls"] < h["session_calls"] and s["tokens"] + est_in + h["max_output_tokens"] <= h["session_token_budget"]


def _spend(sid, tokens):
    with lock("budget"):
        st = _state()
        s = st["sessions"].setdefault(sid, {"calls": 0, "tokens": 0})
        s["calls"] += 1
        s["tokens"] += tokens
        s["ts"] = time.time()
        st["total"]["calls"] += 1
        st["total"]["tokens"] += tokens
        if len(st["sessions"]) > 50:
            for k in sorted(st["sessions"], key=lambda k: st["sessions"][k].get("ts", 0))[:-50]:
                del st["sessions"][k]
        save_json(BUDGET, st)


def _run(cfg, prompt, timeout):
    h = cfg["haiku"]
    env = dict(os.environ, TOKEN_SAVER_INNER="1")
    b = h["backend"]
    try:
        if b == "claude_cli":
            exe = shutil.which("claude")
            if not exe:
                return None
            r = subprocess.run([exe, "-p", "--model", "haiku"], input=prompt, capture_output=True,
                               text=True, timeout=timeout, env=env)
        elif b == "cmd":
            if not h.get("cmd"):
                return None
            r = subprocess.run(shlex.split(h["cmd"]), input=prompt, capture_output=True, text=True,
                               timeout=timeout, env=env)
        elif b == "api":
            key = os.environ.get("ANTHROPIC_API_KEY")
            if not key:
                return None
            body = json.dumps({"model": h["model"], "max_tokens": h["max_output_tokens"],
                               "messages": [{"role": "user", "content": prompt}]}).encode()
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", body, {
                "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.load(resp)
            return "".join(x.get("text", "") for x in data.get("content", [])) or None
        else:
            return None
    except Exception:
        return None
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def call(cfg, sid, prompt, timeout):
    """Один вызов с учётом бюджета. None — нельзя/не вышло (вызывающий код обязан иметь запасной путь)."""
    if not allowed(cfg, sid, est_tokens(prompt)):
        return None
    out = _run(cfg, prompt, timeout)
    _spend(sid, est_tokens(prompt, out or ""))   # платим даже за неудачу: токены ушли
    if out:
        out = out[: cfg["haiku"]["max_output_tokens"] * 5]
    return out


def _trim(text, limit):
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + "\n[... trimmed ...]\n" + text[-half:]


def digest(cfg, sid, lines):
    """Короткая выжимка скрытой части вывода (список строк) или None."""
    h = cfg["haiku"]
    body = _trim("\n".join(lines), h["max_input_chars"])
    prompt = ("You compress the hidden middle of a command output for another engineer. "
              "Output at most 12 lines. Keep exact error messages, file:line, test names, versions "
              "and numbers verbatim. No preamble, no advice.\n\n<output>\n" + body + "\n</output>")
    out = call(cfg, sid, prompt, h["digest_timeout"])
    return out.splitlines()[:14] if out else None


def label(cfg, sid, numbered):
    """Учитель: какие из пронумерованных строк нужны для разбора проблемы. -> set[int] | None."""
    h = cfg["haiku"]
    body = _trim("\n".join(f"{n}: {t[:300]}" for n, t in numbered), h["max_input_chars"])
    prompt = ("Below are numbered lines from a command output. Return ONLY a JSON array with the numbers of "
              "at most 20 lines someone debugging would need (errors, failing test names, file:line, key "
              "numbers). No prose.\n\n" + body)
    out = call(cfg, sid, prompt, h["teacher_timeout"])
    if not out:
        return None
    m = re.search(r"\[[\d,\s]*\]", out)
    if not m:
        return None
    try:
        return {int(x) for x in json.loads(m.group())}
    except ValueError:
        return None


def session_spent(sid):
    return _state()["sessions"].get(sid, {"calls": 0, "tokens": 0})
