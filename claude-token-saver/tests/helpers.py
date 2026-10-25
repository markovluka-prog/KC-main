import importlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
PY = sys.executable
MODS = ("common", "labels", "scorer", "haiku", "ctxpred", "tuner")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.ts = self.tmp / "token-saver"
        shutil.copytree(PKG / "token-saver", self.ts, ignore=shutil.ignore_patterns("state", "__pycache__"))
        self._path_added = False

    def tearDown(self):
        if self._path_added and str(self.ts) in sys.path:
            sys.path.remove(str(self.ts))
        for m in MODS:
            sys.modules.pop(m, None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- запуск скриптов как подпроцессов ---
    def py(self, script, *args, stdin=None, env=None):
        import os
        e = dict(os.environ, **(env or {}))
        e.pop("TOKEN_SAVER_INNER", None) if env is None or "TOKEN_SAVER_INNER" not in env else None
        return subprocess.run([PY, str(self.ts / script), *args], input=stdin, capture_output=True,
                              text=True, env=e)

    def run_cmd(self, cmd, sid="s", fam="test", h="abc", env=None):
        return self.py("run_filtered.py", "--sid", sid, "--fam", fam, "--h", h, cmd, env=env)

    # --- импорт свежей копии модулей из временной папки ---
    def mods(self):
        for m in MODS:
            sys.modules.pop(m, None)
        sys.path.insert(0, str(self.ts))
        self._path_added = True
        return types.SimpleNamespace(**{m: importlib.import_module(m) for m in MODS})

    # --- конфиг и события ---
    def cfg(self):
        return json.loads((self.ts / "config.json").read_text())

    def set_cfg(self, **kw):
        c = self.cfg()
        for k, v in kw.items():
            if isinstance(v, dict) and isinstance(c.get(k), dict):
                c[k].update(v)
            else:
                c[k] = v
        (self.ts / "config.json").write_text(json.dumps(c))

    def events(self):
        p = self.ts / "state" / "events.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def stop(self, sid, transcript=""):
        return self.py("tuner.py", stdin=json.dumps({"session_id": sid, "transcript_path": str(transcript)}))


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def write_transcript(path, entries, noise_text=""):
    """entries: [{ts, text, cmds?, usage?}]. noise_text попадает в tool_result (его учитывать нельзя)."""
    with open(path, "w") as f:
        f.write(json.dumps({"type": "user", "timestamp": iso(time.time()), "message": {
            "role": "user", "content": [{"type": "tool_result", "content": noise_text}]}}) + "\n")
        f.write("not json at all\n")
        for e in entries:
            content = [{"type": "text", "text": e.get("text", "")}]
            for c in e.get("cmds", []):
                content.append({"type": "tool_use", "name": "Bash", "input": {"command": c}})
            msg = {"role": "assistant", "content": content}
            if e.get("usage"):
                msg["usage"] = e["usage"]
            f.write(json.dumps({"type": "assistant", "timestamp": iso(e["ts"]), "message": msg}) + "\n")
