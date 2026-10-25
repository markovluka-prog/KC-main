#!/usr/bin/env python3
"""PreToolUse-хук.

1) Оборачивает шумные Bash-команды в run_filtered.py (только из белого списка, только простые
   команды без `;`, `&&`, `|`, `>`, `$()`), передавая семейство команды (test/build/git/...).
2) Фиксирует «добор» — когда Claude лезет в сохранённый полный лог (сигнал для MCTS).
Любая ошибка = тихий выход 0: хук никогда не мешает работе.
"""
import hashlib
import json
import os
import re
import shlex
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FAMILIES, INNER, LOGS, ROOT, append_event, load_config  # noqa: E402

CHAIN = re.compile(r"[;&|<>`$()\n\\]")
DENY_ARGS = {"--fix", "-fix", "--fix-only", "--write", "-w", "-delete", "-exec", "-ok", "-execdir",
             "--force", "--output", "--in-place", "-i"}
LOGNAME = re.compile(r"\d{8}-\d{6}-\d+-([a-z]+)-[0-9a-f]*\.log")


def _rflag(a):
    return any(x.startswith("-") and not x.startswith("--") and set("rR") & set(x) for x in a)


def classify(t):
    """Токены команды -> семейство или None (не оборачивать)."""
    if not t:
        return None
    exe, a = os.path.basename(t[0]), t[1:]
    a0 = a[0] if a else ""
    if any(x in DENY_ARGS for x in a):
        return None
    if exe in ("python", "python3", "py"):
        if len(a) > 1 and a[0] == "-m":
            if a[1] in ("pytest", "unittest"):
                return "test"
            if a[1] in ("mypy", "ruff", "pylint", "flake8"):
                return "lint"
        return None
    if exe in ("pytest", "py.test", "tox", "nox", "jest", "vitest"):
        return "test"
    if exe in ("eslint", "ruff", "mypy", "pylint", "flake8"):
        return "lint"
    if exe == "tsc":
        return "build"
    if exe in ("npm", "pnpm", "yarn", "bun"):
        if a0 == "test" or (a0 == "run" and a[1:2] == ["test"]):
            return "test"
        if a0 in ("install", "ci", "i"):
            return "install"
        if a0 == "build" or (a0 == "run" and a[1:2] == ["build"]):
            return "build"
        if a0 == "lint" or (a0 == "run" and a[1:2] in (["lint"], ["typecheck"], ["check"])):
            return "lint"
        return None
    if exe in ("pip", "pip3", "poetry"):
        return "install" if a0 == "install" else None
    if exe == "cargo":
        return {"test": "test", "build": "build", "check": "build", "clippy": "lint"}.get(a0)
    if exe == "go":
        return {"test": "test", "build": "build", "vet": "lint"}.get(a0)
    if exe == "dotnet":
        return {"test": "test", "build": "build"}.get(a0)
    if exe in ("mvn", "mvnw"):
        return {"test": "test", "package": "build", "verify": "build", "compile": "build"}.get(a0)
    if exe in ("gradle", "gradlew"):
        return {"test": "test", "build": "build", "check": "build"}.get(a0)
    if exe == "make":
        return {"test": "test", "tests": "test", "build": "build", "all": "build", "lint": "lint",
                "check": "lint"}.get(a0)
    if exe == "git":
        return "git" if a0 in ("log", "diff", "show", "blame") else None
    if exe == "grep":
        return "search" if (_rflag(a) or "--recursive" in a) else None
    if exe in ("rg", "find"):
        return "search"
    if exe in ("cat", "tree"):
        return "files"
    if exe == "ls":
        return "files" if _rflag([x for x in a if "R" in x]) else None
    if exe == "journalctl":
        return "logs"
    if exe == "docker":
        if a0 == "build":
            return "build"
        return "logs" if (a0 == "logs" or a[:2] == ["compose", "logs"]) else None
    if exe == "kubectl":
        return "logs" if a0 == "logs" else None
    if exe == "terraform":
        return "build" if a0 == "plan" else None
    return None


def wrappable(cmd):
    """-> семейство или None."""
    if not cmd.strip() or "run_filtered.py" in cmd or CHAIN.search(cmd):
        return None
    try:
        t = shlex.split(cmd)
    except ValueError:
        return None
    while t and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=\S*", t[0]):
        t = t[1:]
    fam = classify(t)
    return fam if fam in FAMILIES else None


def build_command(cmd, sid, fam):
    py = Path(sys.executable).as_posix()
    runner = (ROOT / "run_filtered.py").as_posix()
    h = hashlib.sha1(cmd.encode()).hexdigest()[:8]
    return (f"{shlex.quote(py)} {shlex.quote(runner)} --sid {shlex.quote(sid)} --fam {fam} "
            f"--h {h} {shlex.quote(cmd)}")


def main():
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    ti = data.get("tool_input") or {}
    sid = str(data.get("session_id", ""))
    cfg = load_config()

    blob = json.dumps(ti, ensure_ascii=False)
    if str(LOGS) in blob or LOGS.as_posix() in blob:
        m = LOGNAME.search(blob)
        append_event({"kind": "recovery", "sid": sid, "ts": time.time(), "tool": tool,
                      "fam": m.group(1) if m else "other"})

    if tool == "Bash" and cfg.get("wrap_enabled", True) and not ti.get("run_in_background"):
        cmd = ti.get("command", "")
        fam = wrappable(cmd)
        if fam:
            hso = {"hookEventName": "PreToolUse",
                   "updatedInput": {**ti, "command": build_command(cmd, sid, fam)}}
            if cfg.get("wrap_permission") == "allow":
                hso["permissionDecision"] = "allow"
                hso["permissionDecisionReason"] = "token-saver: output filter (read-only/build command)"
            print(json.dumps({"hookSpecificOutput": hso}))


if __name__ == "__main__":
    if not INNER:
        try:
            main()
        except Exception:
            pass
    sys.exit(0)
