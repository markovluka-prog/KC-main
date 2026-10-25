#!/usr/bin/env python3
"""Установщик token-saver (идемпотентный): файлы, хуки в settings.json, блок в CLAUDE.md.

  python3 install.py                 # в ~/.claude
  python3 install.py --dry-run       # показать итоговый settings.json, ничего не писать
  python3 install.py --uninstall
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BEGIN, END = "<!-- token-saver:begin -->", "<!-- token-saver:end -->"
ENV = {
    "MAX_THINKING_TOKENS": "10000",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku",
    "MAX_MCP_OUTPUT_TOKENS": "8000",
}


def load_json(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def strip_ours(settings):
    hooks = settings.get("hooks", {})
    for event in list(hooks):
        keep = [e for e in hooks[event]
                if not any("token-saver" in h.get("command", "") for h in e.get("hooks", []))]
        if keep:
            hooks[event] = keep
        else:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)


def strip_block(text):
    if BEGIN in text and END in text:
        a, b = text.index(BEGIN), text.index(END) + len(END)
        text = (text[:a].rstrip() + "\n" + text[b:].lstrip()).strip() + "\n"
        return text if text.strip() else ""
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--claude-dir", default="~/.claude")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--force", action="store_true", help="перезаписать уже заданные env-ключи")
    ap.add_argument("--no-model", action="store_true", help="не ставить model=sonnet по умолчанию")
    ap.add_argument("--haiku", action="store_true",
                    help="включить Haiku (дайджест + учитель); по умолчанию выключен, тратит токены")
    a = ap.parse_args()

    cdir = Path(a.claude_dir).expanduser()
    dest = cdir / "token-saver"
    sfile, mfile = cdir / "settings.json", cdir / "CLAUDE.md"
    settings = load_json(sfile)
    claude_md = mfile.read_text(encoding="utf-8") if mfile.exists() else ""

    strip_ours(settings)
    claude_md = strip_block(claude_md)

    if not a.uninstall:
        py = Path(sys.executable).as_posix()
        pre = f'"{py}" "{(dest / "pre_tool.py").as_posix()}"'
        stop = f'"{py}" "{(dest / "tuner.py").as_posix()}"'
        hooks = settings.setdefault("hooks", {})
        hooks.setdefault("PreToolUse", []).append(
            {"matcher": "Bash|Read|Grep", "hooks": [{"type": "command", "command": pre, "timeout": 10}]})
        hooks.setdefault("Stop", []).append(
            {"hooks": [{"type": "command", "command": stop, "timeout": 40}]})
        env = settings.setdefault("env", {})
        for key, val in ENV.items():
            if a.force or key not in env:
                env[key] = val
        if not a.no_model and "model" not in settings:
            settings["model"] = "sonnet"
        block = (HERE / "CLAUDE.token-saver.md").read_text(encoding="utf-8").strip()
        claude_md = (claude_md.rstrip() + "\n\n" + block + "\n").lstrip()

    if a.dry_run:
        print(json.dumps(settings, ensure_ascii=False, indent=2))
        return

    cdir.mkdir(parents=True, exist_ok=True)
    if sfile.exists():
        shutil.copy2(sfile, cdir / f"settings.json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    sfile.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if claude_md:
        mfile.write_text(claude_md, encoding="utf-8")
    elif mfile.exists():
        mfile.unlink()

    agent = cdir / "agents" / "output-filter.md"
    if a.uninstall:
        agent.unlink(missing_ok=True)
        shutil.rmtree(dest, ignore_errors=True)
        print(f"Удалено из {cdir}. Бэкап settings.json лежит рядом.")
        return

    dest.mkdir(parents=True, exist_ok=True)
    for f in (HERE / "token-saver").glob("*.py"):
        shutil.copy2(f, dest / f.name)
    if not (dest / "config.json").exists():
        shutil.copy2(HERE / "token-saver" / "config.json", dest / "config.json")
    if a.haiku:
        cfg_file = dest / "config.json"
        cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
        cfg.setdefault("haiku", {})["enabled"] = True
        cfg_file.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    agent.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "agents" / "output-filter.md", agent)
    print(f"Установлено в {cdir}. Перезапусти Claude Code. Статус: python3 {dest / 'tuner.py'} --status")


if __name__ == "__main__":
    main()
