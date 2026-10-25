import json
import random
import subprocess
import sys
import tempfile
import time
import shutil
import unittest
from itertools import product
from pathlib import Path

from helpers import PKG, PY, Base


class TestRunner(Base):
    def test_truncates_keeps_errors_and_exit_code(self):
        r = self.run_cmd('seq 1 3000; echo "ERROR boom happened"; seq 5000 5400; exit 3')
        self.assertEqual(r.returncode, 3)
        self.assertIn("lines hidden", r.stdout)
        self.assertIn("ERROR boom happened", r.stdout)
        self.assertIn("\n5400\n", "\n" + r.stdout)
        self.assertNotIn("\n1500\n", "\n" + r.stdout)
        logs = list((self.ts / "state" / "logs").glob("*-test-*.log"))   # семейство в имени файла
        self.assertEqual(len(logs), 1)
        self.assertIn("\n1500\n", "\n" + logs[0].read_text())
        ev = self.events()[-1]
        self.assertTrue(ev["trunc"] and ev["rc"] == 3 and ev["out"] < ev["raw"] / 5)
        self.assertEqual((ev["fam"], ev["log"], ev["hn"], ev["tn"]), ("test", str(logs[0]), 60, 60))

    def test_short_output_untouched(self):
        r = self.run_cmd("echo hi; echo err >&2")
        self.assertEqual(r.stdout.strip().splitlines(), ["hi", "err"])
        self.assertEqual(r.returncode, 0)

    def test_progress_bars_and_repeats_collapsed(self):
        r = self.run_cmd(r"printf 'a 10%%\ra 50%%\ra 100%%\n'; for i in 1 2 3 4 5; do echo same; done")
        self.assertIn("a 100%", r.stdout)
        self.assertNotIn("a 10%", r.stdout.replace("100%", ""))
        self.assertIn("same  [x5]", r.stdout)

    def test_kill_switch(self):
        self.set_cfg(wrap_enabled=False)
        r = self.run_cmd("seq 1 1000")
        self.assertNotIn("hidden", r.stdout)
        self.assertEqual(len(r.stdout.splitlines()), 1000)

    def test_each_family_uses_its_own_path(self):
        self.set_cfg(paths={"test": {"max_lines": 60, "head_frac": 0.5, "salient_cap": 0, "collapse": True},
                            "git": {"max_lines": 400, "head_frac": 0.5, "salient_cap": 0, "collapse": True}})
        n_test = len(self.run_cmd("seq 1 3000", fam="test").stdout.splitlines())
        n_git = len(self.run_cmd("seq 1 3000", fam="git").stdout.splitlines())
        n_other = len(self.run_cmd("seq 1 3000", fam="build").stdout.splitlines())   # запасной путь (120)
        self.assertLess(n_test, n_other)
        self.assertLess(n_other, n_git)
        self.assertEqual(self.events()[0]["path"]["max_lines"], 60)


class TestPreTool(Base):
    def hook(self, tool, ti, env=None):
        r = self.py("pre_tool.py", stdin=json.dumps({"session_id": "s1", "tool_name": tool, "tool_input": ti}), env=env)
        self.assertEqual(r.returncode, 0)
        return json.loads(r.stdout)["hookSpecificOutput"] if r.stdout.strip() else None

    def test_families(self):
        expect = {"pytest -q": "test", "npm run test": "test", "git log --oneline": "git", "cargo build": "build",
                  "make test": "test", "pip install requests": "install", "grep -rn foo src": "search",
                  "ls -laR": "files", "FOO=1 pytest": "test", "ruff check .": "lint", "docker logs web": "logs",
                  "npm run lint": "lint", "go vet ./...": "lint", "tsc": "build", "cat a.txt": "files",
                  "python3 -m pytest tests": "test", "kubectl logs pod": "logs"}
        for cmd, fam in expect.items():
            out = self.hook("Bash", {"command": cmd})
            self.assertIsNotNone(out, cmd)
            self.assertIn(f"--fam {fam} ", out["updatedInput"]["command"], cmd)
            self.assertEqual(out["permissionDecision"], "allow")

    def test_unsafe_or_compound_not_wrapped(self):
        for cmd in ["cd x && pytest", "rm -rf build", "make deploy", "find . -delete", "ruff check --fix .",
                    "pytest | tail", "echo hi", "export A=1", "cat a > b", "npm publish", "git push",
                    "pytest $(whoami)", "python3 script.py", "grep foo file.txt"]:
            self.assertIsNone(self.hook("Bash", {"command": cmd}), cmd)

    def test_background_disabled_none_modes(self):
        self.assertIsNone(self.hook("Bash", {"command": "pytest", "run_in_background": True}))
        self.set_cfg(wrap_permission="none")
        self.assertNotIn("permissionDecision", self.hook("Bash", {"command": "pytest"}))
        self.set_cfg(wrap_enabled=False)
        self.assertIsNone(self.hook("Bash", {"command": "pytest"}))

    def test_end_to_end_rewritten_command(self):
        big = self.tmp / "big.txt"
        big.write_text("\n".join(f"line {i}" for i in range(5000)) + "\n")
        out = self.hook("Bash", {"command": f"cat {big}"})
        r = subprocess.run(out["updatedInput"]["command"], shell=True, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("lines hidden", r.stdout)
        self.assertLess(len(r.stdout), 0.1 * big.stat().st_size)

    def test_recovery_event_has_family(self):
        r = self.run_cmd("seq 1 3000", fam="git")
        log = self.events()[-1]["log"]
        self.assertIsNone(self.hook("Read", {"file_path": log}))
        self.assertIsNone(self.hook("Bash", {"command": f"grep -n 99 {log}"}))
        rec = [e for e in self.events() if e["kind"] == "recovery"]
        self.assertEqual([e["fam"] for e in rec], ["git", "git"])

    def test_inner_guard_and_garbage(self):
        self.assertIsNone(self.hook("Bash", {"command": "pytest"}, env={"TOKEN_SAVER_INNER": "1"}))
        r = self.py("pre_tool.py", stdin="not json")
        self.assertEqual((r.returncode, r.stdout), (0, ""))


class TestTunerPerFamily(Base):
    def fake(self, sid, fam, n=3, h="a", raw=10000, out=2000, trunc=True):
        (self.ts / "state").mkdir(exist_ok=True)
        with open(self.ts / "state" / "events.jsonl", "a") as f:
            for i in range(n):
                f.write(json.dumps({"kind": "filter", "sid": sid, "ts": time.time(), "h": h + str(i), "fam": fam,
                                    "raw": raw, "out": out, "trunc": trunc, "rc": 0,
                                    "path": {"max_lines": 120, "head_frac": 0.5, "salient_cap": 30, "collapse": True},
                                    "tl": 1}) + "\n")

    def stop_info(self):
        return [e for e in self.events() if e["kind"] == "stop"][-1]["ep"]

    def test_independent_trees_and_paths_per_family(self):
        self.fake("s1", "test")
        self.fake("s1", "git")
        self.stop("s1")
        trees = json.loads((self.ts / "state" / "trees.json").read_text())
        self.assertEqual(sorted(trees["fam"]), ["git", "test"])
        self.assertEqual(trees["episodes"], 2)
        cfg = self.cfg()
        self.assertEqual(sorted(cfg["paths"]), ["git", "test"])
        self.assertAlmostEqual(self.stop_info()["fam"]["test"]["reward"], 0.8, places=2)

    def test_recovery_penalizes_only_its_family(self):
        self.fake("s2", "test")
        self.fake("s2", "git")
        with open(self.ts / "state" / "events.jsonl", "a") as f:
            f.write(json.dumps({"kind": "recovery", "sid": "s2", "ts": time.time(), "fam": "git"}) + "\n")
        self.stop("s2")
        fam = self.stop_info()["fam"]
        self.assertAlmostEqual(fam["test"]["reward"], 0.8, places=2)
        self.assertAlmostEqual(fam["git"]["reward"], 0.65, places=2)

    def test_one_update_per_episode_and_small_outputs_ignored(self):
        self.fake("s3", "test")
        self.fake("s3", "lint", raw=500, out=100)    # < min_raw_chars
        self.stop("s3")
        self.stop("s3")                               # новых событий нет
        trees = json.loads((self.ts / "state" / "trees.json").read_text())
        self.assertEqual((sorted(trees["fam"]), trees["episodes"]), (["test"], 1))

    def test_freeze_reset_status(self):
        self.py("tuner.py", "--freeze")
        self.assertFalse(self.cfg()["tuner"]["enabled"])
        self.fake("s4", "test")
        self.stop("s4")
        self.assertFalse((self.ts / "state" / "trees.json").exists())
        self.py("tuner.py", "--unfreeze")
        self.fake("s5", "test")
        self.stop("s5")
        self.assertIn("test", self.py("tuner.py", "--status").stdout)
        self.py("tuner.py", "--reset")
        self.assertEqual(self.cfg()["paths"], {})

    def test_mcts_converges_on_synthetic_world(self):
        m = self.mods()
        tuner, common = m.tuner, m.common

        def true_reward(p):
            saved = {60: 0.9, 120: 0.8, 200: 0.7, 400: 0.5}[p["max_lines"]]
            rec = {60: 4.0, 120: 2.5, 200: 1.0, 400: 0.2}[p["max_lines"]]
            rec += {0: 1.5, 30: 0.4, 80: 0.0}[p["salient_cap"]] + (0.3 if p["head_frac"] == 0.25 else 0)
            saved -= 0.05 if p["salient_cap"] == 80 else 0
            saved -= 0.0 if p["collapse"] else 0.08
            return saved - 0.15 * rec

        leaves = [dict(zip(common.ORDER, vs)) for vs in product(*[common.SPACE[o] for o in common.ORDER])]
        best = max(true_reward(p) for p in leaves)
        regrets = []
        for seed in range(5):
            rng = random.Random(seed)
            tree = tuner.seed_tree()
            t = dict(common.DEFAULT_CONFIG["tuner"])
            path, tl = dict(common.DEFAULT_PATH), 0
            for _ in range(500):
                tuner.update(tree, path, tl, max(-1, min(1, true_reward(path) + rng.gauss(0, 0.1))))
                path, tl = tuner.choose(tree, t, rng)
            regrets.append(best - true_reward(tuner.incumbent(tree)))
        default_regret = best - true_reward(common.DEFAULT_PATH)
        self.assertGreater(default_regret, 0.1)
        self.assertLess(sum(regrets) / len(regrets), default_regret / 2)
        self.assertLess(max(regrets), 0.08)


class TestInstaller(unittest.TestCase):
    def test_install_idempotent_and_uninstall(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            cdir = tmp / ".claude"
            cdir.mkdir()
            (cdir / "settings.json").write_text(json.dumps({
                "env": {"MAX_THINKING_TOKENS": "4000"},
                "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}}))
            (cdir / "CLAUDE.md").write_text("# my rules\n")
            run = lambda *a: subprocess.run([PY, str(PKG / "install.py"), "--claude-dir", str(cdir), *a],  # noqa: E731
                                            capture_output=True, text=True, check=True)
            run()
            run()
            s = json.loads((cdir / "settings.json").read_text())
            self.assertEqual(s["env"]["MAX_THINKING_TOKENS"], "4000")
            self.assertEqual(s["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "haiku")
            self.assertEqual(len(s["hooks"]["PreToolUse"]), 1)
            self.assertEqual(len(s["hooks"]["Stop"]), 2)
            md = (cdir / "CLAUDE.md").read_text()
            self.assertEqual(md.count("token-saver:begin"), 1)
            self.assertIn("# my rules", md)
            for f in ("common", "labels", "scorer", "haiku", "ctxpred", "tuner", "pre_tool", "run_filtered"):
                self.assertTrue((cdir / "token-saver" / f"{f}.py").exists(), f)
            self.assertTrue((cdir / "agents" / "output-filter.md").exists())
            cmd = s["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            r = subprocess.run(cmd, shell=True, input=json.dumps(
                {"session_id": "z", "tool_name": "Bash", "tool_input": {"command": "pytest"}}),
                capture_output=True, text=True)
            self.assertIn("run_filtered.py", r.stdout)
            cfg = json.loads((cdir / "token-saver" / "config.json").read_text())
            self.assertFalse(cfg["haiku"]["enabled"])            # по умолчанию Haiku выключен
            run("--haiku")
            cfg = json.loads((cdir / "token-saver" / "config.json").read_text())
            self.assertTrue(cfg["haiku"]["enabled"])
            run("--uninstall")
            s = json.loads((cdir / "settings.json").read_text())
            self.assertNotIn("PreToolUse", s.get("hooks", {}))
            self.assertEqual(len(s["hooks"]["Stop"]), 1)
            self.assertNotIn("token-saver", (cdir / "CLAUDE.md").read_text())
            self.assertFalse((cdir / "token-saver").exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
