"""token-saver: общие утилиты (пути, конфиг, журнал событий, замок)."""
import contextlib
import json
import os
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
LOGS = STATE / "logs"
EVENTS = STATE / "events.jsonl"
TREES = STATE / "trees.json"
MODEL = STATE / "model.json"
BUDGET = STATE / "budget.json"
CTXFILE = STATE / "ctx.json"
CONFIG = ROOT / "config.json"

# Дочерний `claude -p`, который мы сами запускаем для Haiku, наследует это окружение.
# Все хуки при INNER молча выходят — иначе получилась бы бесконечная рекурсия.
INNER = os.environ.get("TOKEN_SAVER_INNER") == "1"

# Пространство поиска MCTS. Порядок = глубина дерева.
ORDER = ["max_lines", "head_frac", "salient_cap", "collapse"]
SPACE = {
    "max_lines": [60, 120, 200, 400],   # сколько строк вывода показывать
    "head_frac": [0.25, 0.5],           # доля «головы» (остальное — «хвост»)
    "salient_cap": [0, 30, 80],         # сколько строк из скрытой середины спасать
    "collapse": [True, False],          # схлопывать повторяющиеся строки
}
DEFAULT_PATH = {"max_lines": 120, "head_frac": 0.5, "salient_cap": 30, "collapse": True}

# Семейства команд: у pytest и git log оптимальные настройки разные.
FAMILIES = ["test", "build", "lint", "install", "git", "search", "files", "logs", "other"]

SALIENT = re.compile(
    r"\b(error|errors|failed|failure|fatal|panic|exception|traceback|assertion\w*|denied|segfault|cannot|undefined)\b|✗|✖",
    re.I,
)

DEFAULT_CONFIG = {
    "wrap_enabled": True,        # False = фильтр выключен (команды идут как есть)
    "wrap_permission": "allow",  # "allow" | "none"
    "path": DEFAULT_PATH,        # запасной конфиг для семейств без собственного
    "tl": 0,
    "paths": {},                 # семейство -> текущий конфиг (пишет tuner)
    "tls": {},
    "tuner": {
        "enabled": True,
        "c": 0.7,                    # константа исследования UCT
        "recovery_penalty": 0.15,    # штраф за каждый «добор» скрытого
        "fail_trunc_penalty": 0.05,  # штраф за скрытый вывод упавшей команды
        "miss_penalty": 0.5,         # штраф за долю цитат Claude, которых не было на экране
        "min_raw_chars": 2000,       # меньшие выводы в награде не учитываются
        "explore_prob": 0.35,
        "warmup": 8,
    },
    "scorer": {
        "enabled": True,
        "min_pos": 20,           # пока положительных меток меньше — работает regexp
        "threshold_mult": 1.5,   # брать строки с p > mult × базовая частота
        "train_budget_s": 4.0,
    },
    "haiku": {
        "enabled": False,        # включается явно: tuner.py --haiku on
        "backend": "claude_cli",  # claude_cli | api | cmd
        "cmd": "",               # для backend=cmd (тесты, свои обёртки)
        "model": "claude-haiku-5-5",
        "digest_min_chars": 32000,
        "max_input_chars": 120000,
        "max_output_tokens": 300,
        "session_calls": 10,
        "session_token_budget": 300000,
        "teacher_prob": 0.3,
        "digest_timeout": 45,
        "teacher_timeout": 20,
    },
    "ctx": {
        "enabled": True,
        "window": 200000,
        "soft_frac": 0.5,        # порог = 50% окна (как CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
        "warn_turns": 3,
        "cooldown_turns": 10,
    },
}


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        user = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return cfg
    for key, val in user.items():
        if isinstance(val, dict) and isinstance(cfg.get(key), dict):
            cfg[key].update(val)
        else:
            cfg[key] = val
    for key in ORDER:
        if cfg["path"].get(key) not in SPACE[key]:
            cfg["path"][key] = DEFAULT_PATH[key]
    return cfg


def valid_path(p):
    return isinstance(p, dict) and all(p.get(k) in SPACE[k] for k in ORDER)


def path_for(cfg, fam):
    p = cfg.get("paths", {}).get(fam)
    return {k: p[k] for k in ORDER} if valid_path(p) else cfg["path"]


def tl_for(cfg, fam):
    return cfg.get("tls", {}).get(fam, cfg.get("tl", 0)) if valid_path(cfg.get("paths", {}).get(fam)) else cfg.get("tl", 0)


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def append_event(ev):
    STATE.mkdir(parents=True, exist_ok=True)
    with open(EVENTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")


def read_events():
    out = []
    try:
        with open(EVENTS, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except FileNotFoundError:
        pass
    return out


def rotate_events(limit_bytes=2_000_000, keep=3000):
    try:
        if EVENTS.stat().st_size <= limit_bytes:
            return
        lines = EVENTS.read_text(encoding="utf-8").splitlines()[-keep:]
        EVENTS.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


@contextlib.contextmanager
def lock(name="lock", timeout=5.0):
    """Межпроцессный замок через O_EXCL-файл (без fcntl, работает и на Windows)."""
    STATE.mkdir(parents=True, exist_ok=True)
    path = STATE / f"{name}.lock"
    t0 = time.time()
    fd = None
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > 60:  # протухший замок
                    path.unlink()
                    continue
            except OSError:
                pass
            if time.time() - t0 > timeout:
                break
            time.sleep(0.05)
    try:
        yield
    finally:
        if fd is not None:
            os.close(fd)
            try:
                path.unlink()
            except OSError:
                pass
