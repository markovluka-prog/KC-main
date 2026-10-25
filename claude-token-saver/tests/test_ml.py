import json
import random
import sys
import time
import unittest

from helpers import PY, Base, write_transcript

BIG = ('for i in $(seq 1 2000); do echo "INFO batch $i ok"; done; '
       'echo "reconcile_mismatch ledger_7781 delta=42"; for i in $(seq 1 500); do echo "INFO tail $i"; done')


class TestLabels(Base):
    def test_citations_and_commands_and_noise(self):
        L = self.mods().labels
        lines = [f"INFO batch {i} ok" for i in range(300)]
        lines[100] = "reconcile_mismatch ledger_7781 delta=42"
        lines[200] = "timeout contacting payment_gateway region=eu-west-1"
        for i in range(250, 260):
            lines[i] = "WARN retrying shared_pool_connection"       # токен встречается часто -> не цитата
        tr = self.tmp / "t.jsonl"
        now = time.time()
        write_transcript(tr, [
            {"ts": now - 50, "text": "раньше, ledger_7781 и payment_gateway тут не должны считаться"},
            {"ts": now + 1, "text": "Причина: ledger_7781 и shared_pool_connection", "cmds": [
                "grep -n payment_gateway /x/logs/20260101-000000-1-test-abc.log",
                "sed -n '5,7p' /x/logs/20260101-000000-1-test-abc.log"]},
        ], noise_text="reconcile_mismatch в tool_result — учитывать нельзя")
        entries, usage = L.parse_transcript(tr)
        self.assertEqual(len(entries), 2)                          # мусорная строка и user пропущены
        texts, cmds = L.after(entries, now)
        self.assertEqual(len(texts), 1)
        cited = L.cited_lines(lines, L.distinctive(texts))
        # ledger_7781 — да; payment_gateway — тоже (Claude назвал его в вызове grep);
        # shared_pool_connection встречается в 10 строках -> слишком частый, не цитата
        self.assertEqual(cited, {100, 200})
        cmd_l = L.command_labels(cmds, "20260101-000000-1-test-abc.log", lines)
        self.assertEqual(cmd_l, {200, 4, 5, 6})                     # grep payment_gateway + sed 5,7p

    def test_graceful_on_missing_transcript_and_usage(self):
        L = self.mods().labels
        self.assertEqual(L.parse_transcript(self.tmp / "nope.jsonl"), ([], None))
        self.assertEqual(L.context_tokens({"input_tokens": 10, "cache_read_input_tokens": 90_000,
                                           "cache_creation_input_tokens": 5}), 90_015)
        self.assertIsNone(L.context_tokens(None))


class TestScorer(Base):
    def make_log(self, rng):
        lines = [f"INFO worker {rng.randint(1, 9)} processed batch {i} ok" for i in range(400)]
        for _ in range(3):   # приманки: совпадают с regexp, но никогда не нужны
            lines[rng.randrange(50, 350)] = "WARN cannot find optional plugin foo (ignored)"
        pos = set()
        for _ in range(2):   # нужные строки, regexp их не видит
            i = rng.randrange(50, 350)
            lines[i] = f"payment_gateway timeout after 30s id={rng.randint(1000, 9999)}"
            pos.add(i)
        return lines, pos

    def test_learns_what_regex_cannot(self):
        S = self.mods().scorer
        rng = random.Random(1)
        m = S.Scorer()
        for _ in range(40):
            lines, pos = self.make_log(rng)
            m.train_log(lines, pos, "test", rng, time.time() + 5)
        self.assertGreaterEqual(m.n_pos, 40)
        hits_m = hits_r = total = 0
        for _ in range(20):
            lines, pos = self.make_log(rng)
            r = S.recall_at_cap(m, lines, 60, 340, pos, 4, "test")
            hits_m += r[0] * len(pos)
            hits_r += r[1] * len(pos)
            total += len(pos)
        print(f"recall@4: model={hits_m / total:.2f} regex={hits_r / total:.2f}")
        self.assertGreater(hits_m / total, 0.85)
        self.assertLess(hits_r / total, 0.3)

    def test_save_load_roundtrip_and_rate_calibration(self):
        S = self.mods().scorer
        rng = random.Random(2)
        m = S.Scorer()
        for _ in range(10):
            lines, pos = self.make_log(rng)
            m.train_log(lines, pos, "test", rng, time.time() + 5)
        m.save()
        m2 = S.load()
        lines, pos = self.make_log(rng)
        f = S.features(lines[next(iter(pos))], 0.5, "test")
        self.assertAlmostEqual(m.predict(f), m2.predict(f), places=2)
        self.assertEqual(m2.n_pos, m.n_pos)
        self.assertLess(m.base_rate(), 0.05)    # положительных ~0.5% строк: поправка весов сохранила калибровку


class TestHaiku(Base):
    def fake(self, body):
        script = self.tmp / "fake_haiku.py"
        script.write_text(body)
        self.set_cfg(haiku={"enabled": True, "backend": "cmd", "cmd": f"{PY} {script}", "digest_min_chars": 5000})

    def test_digest_inserted_budget_enforced_and_inner_env(self):
        import os
        self.fake("import os,sys\nsys.stdin.read()\nprint('DIGEST: 3 failures; inner=' + os.environ.get('TOKEN_SAVER_INNER',''))\n")
        self.set_cfg(haiku={"session_calls": 1})
        r1 = self.run_cmd(BIG, sid="hs")
        self.assertIn("Haiku digest", r1.stdout)
        self.assertIn("inner=1", r1.stdout)                    # ребёнок получил защиту от рекурсии
        self.assertTrue(self.events()[-1]["digest"])
        r2 = self.run_cmd(BIG, sid="hs")                       # лимит 1 вызов на сессию исчерпан
        self.assertNotIn("Haiku digest", r2.stdout)
        self.assertIn("lines hidden", r2.stdout)               # фильтр работает и без Haiku
        b = json.loads((self.ts / "state" / "budget.json").read_text())
        self.assertEqual(b["sessions"]["hs"]["calls"], 1)
        r3 = self.run_cmd(BIG, sid="other-session")            # другая сессия — свой лимит
        self.assertIn("Haiku digest", r3.stdout)
        r4 = self.run_cmd(BIG, sid="x4", env={"TOKEN_SAVER_INNER": "1"})   # внутри дочернего claude Haiku не зовём
        self.assertNotIn("Haiku digest", r4.stdout)

    def test_failing_backend_falls_back_and_big_threshold(self):
        self.fake("import sys\nsys.exit(1)\n")
        r = self.run_cmd(BIG, sid="f")
        self.assertNotIn("Haiku digest", r.stdout)
        self.assertIn("lines hidden", r.stdout)
        self.assertEqual(r.returncode, 0)
        self.fake("print('x')\n")
        small = self.run_cmd("seq 1 1000", sid="g")            # < digest_min_chars (5000)? 1000 строк ≈ 3.9k
        self.assertNotIn("Haiku digest", small.stdout)

    def test_disabled_by_default(self):
        r = self.run_cmd(BIG, sid="d")
        self.assertNotIn("Haiku digest", r.stdout)
        self.assertFalse((self.ts / "state" / "budget.json").exists())

    def test_token_budget_cap(self):
        m = self.mods()
        cfg = m.common.load_config()
        cfg["haiku"].update(enabled=True, session_token_budget=1000)
        self.assertFalse(m.haiku.allowed(cfg, "s", 5000))
        self.assertTrue(m.haiku.allowed(cfg, "s", 100))
        cfg["haiku"]["enabled"] = False
        self.assertFalse(m.haiku.allowed(cfg, "s", 100))

    def test_teacher_trains_student_and_probability_drops_with_agreement(self):
        self.fake("import sys,json\nsys.stdin.read()\nprint('[3, 5, 99999]')\n")
        m = self.mods()
        cfg = m.common.load_config()
        cfg["haiku"]["session_calls"] = 10 ** 6
        cfg["haiku"]["session_token_budget"] = 10 ** 9
        log = self.tmp / "l.log"
        log.write_text("\n".join(f"INFO batch {i} ok" for i in range(500)) + "\n")
        ev = {"kind": "filter", "trunc": True, "log": str(log), "fam": "test", "hn": 60, "tn": 60, "raw": 9999}
        rng = random.Random(0)
        model = m.scorer.Scorer()
        calls = []
        orig = m.haiku.label
        m.haiku.label = lambda *a, **k: calls.append(1) or orig(*a, **k)
        res = m.tuner.teacher_step([ev], cfg, model, rng, "ts", time.time() + 5)
        # пока ответ учителя — только если лог выбран по вероятности 30%: гоняем до срабатывания
        for _ in range(30):
            if res:
                break
            res = m.tuner.teacher_step([ev], cfg, model, rng, "ts", time.time() + 5)
        self.assertIsNotNone(res)
        self.assertEqual(res["positives"], 0)    # строки 3 и 5 — вне скрытой части [60, 440): отфильтрованы
        # доля вызовов зависит от согласия ученика с учителем
        def rate(agree):
            calls.clear()
            r = random.Random(7)
            for _ in range(400):
                model.meta["agree"] = agree      # фиксируем согласие: проверяем именно формулу вероятности
                m.tuner.teacher_step([ev], cfg, model, r, "ts", time.time() + 5)
            return len(calls) / 400
        low, high = rate(0.0), rate(1.0)
        print(f"teacher call rate: agree=0 -> {low:.2f}, agree=1 -> {high:.2f}")
        self.assertGreater(low, 0.2)
        self.assertLess(high, 0.08)


class TestContextPredictor(Base):
    def test_learns_growth_and_warns_once_with_cooldown(self):
        C = self.mods().ctxpred
        cfg = self.mods().common.load_config()
        rng = random.Random(3)
        ctx, msgs, errs = 10_000, [], []
        for turn in range(40):
            tool_k, calls = rng.uniform(1, 6), rng.randint(1, 4)
            ctx += int(1000 * (1.5 + 1.2 * tool_k + 0.3 * calls))      # скрытая истинная динамика
            r = C.update("s", ctx, [tool_k, calls], cfg)
            errs.append(abs(r["err"]) if r["err"] is not None else None)
            if r["msg"]:
                msgs.append((turn, ctx, r["msg"]))
        e = [x for x in errs if x is not None]
        print(f"ctx predictor |err| first10={sum(e[:10]) / 10:.2f}k last10={sum(e[-10:]) / 10:.2f}k")
        self.assertLess(sum(e[-10:]), sum(e[:10]))                       # ошибка прогноза падает
        self.assertTrue(msgs)
        self.assertIn("/compact", msgs[0][2])
        self.assertLessEqual(msgs[0][1], 100_000 + 20_000)               # предупредили около порога, а не после
        self.assertTrue(all(b[0] - a[0] >= 10 for a, b in zip(msgs, msgs[1:])))   # cooldown

    def test_compaction_resets_and_disabled(self):
        m = self.mods()
        cfg = m.common.load_config()
        for ctx in (50_000, 70_000, 20_000, 25_000):                     # сжатие посередине не ломает модель
            self.assertIsNotNone(m.ctxpred.update("s2", ctx, [2.0, 1], cfg))
        cfg["ctx"]["enabled"] = False
        self.assertIsNone(m.ctxpred.update("s2", 30_000, [2.0, 1], cfg))

    def test_stop_hook_emits_system_message_from_transcript_usage(self):
        tr = self.tmp / "t.jsonl"
        write_transcript(tr, [{"ts": time.time(), "text": "ok", "usage": {
            "input_tokens": 5, "cache_read_input_tokens": 118_000, "cache_creation_input_tokens": 2_000}}])
        r = self.stop("cx", tr)
        out = json.loads(r.stdout)
        self.assertIn("/compact", out["systemMessage"])
        self.assertIn("120k", out["systemMessage"])


class TestEndToEndLearning(Base):
    def run_episode(self, sid, assistant_text, cmds=()):
        self.run_cmd(BIG, sid=sid, fam="test")
        ev = [e for e in self.events() if e["kind"] == "filter" and e["sid"] == sid][-1]
        tr = self.tmp / f"{sid}.jsonl"
        write_transcript(tr, [{"ts": ev["ts"] + 1, "text": assistant_text, "cmds": list(cmds)}],
                         noise_text="reconcile_mismatch ledger_7781")
        self.stop(sid, tr)
        return [e for e in self.events() if e["kind"] == "stop" and e["sid"] == sid][-1]["ep"], ev

    def test_missing_cited_line_is_punished_and_model_learns(self):
        ep_bad, ev = self.run_episode("e1", "Падение вызвано ledger_7781 / reconcile_mismatch")
        info = ep_bad["fam"]["test"]
        self.assertEqual(info["miss"], 1.0)                 # цитата была, на экране её не было
        self.assertAlmostEqual(info["reward"], info["saved"] - 0.5, places=2)   # штраф miss_penalty × 1.0
        self.assertEqual(ep_bad["scorer"]["n_pos"], 1)
        self.assertTrue((self.ts / "state" / "model.json").exists())
        ep_ok, _ = self.run_episode("e2", "Всё хорошо, ничего не нашёл")
        self.assertEqual(ep_ok["fam"]["test"]["miss"], 0.0)
        # MCTS между ходами мог сменить конфиг, поэтому сверяем не награды ходов, а формулу
        self.assertAlmostEqual(ep_ok["fam"]["test"]["reward"], ep_ok["fam"]["test"]["saved"], places=2)

    def test_grep_into_log_counts_as_label_and_recovery(self):
        sid = "e3"
        self.run_cmd(BIG, sid=sid, fam="test")
        ev = [e for e in self.events() if e["kind"] == "filter"][-1]
        tr = self.tmp / "e3.jsonl"
        from pathlib import Path
        write_transcript(tr, [{"ts": ev["ts"] + 1, "text": "ищу причину", "cmds": [
            f"grep -n reconcile {ev['log']}"]}])
        self.py("pre_tool.py", stdin=json.dumps({"session_id": sid, "tool_name": "Bash", "tool_input": {
            "command": f"grep -n reconcile {ev['log']}"}}))
        self.stop(sid, tr)
        ep = [e for e in self.events() if e["kind"] == "stop"][-1]["ep"]
        self.assertEqual(ep["fam"]["test"]["recov"], 1)
        self.assertEqual(ep["scorer"]["n_pos"], 1)          # строку нашёл grep -> положительная метка

    def test_filter_starts_using_model_after_enough_labels(self):
        # после min_pos положительных меток ту же «невидимую для regexp» строку начинают спасать
        self.set_cfg(scorer={"min_pos": 5}, tuner={"enabled": False})
        for i in range(8):
            self.run_episode(f"m{i}", "Причина ledger_7781 reconcile_mismatch")
        r = self.run_cmd(BIG, sid="final", fam="test")
        self.assertIn("reconcile_mismatch ledger_7781 delta=42", r.stdout)
        shown = [e for e in self.events() if e["kind"] == "filter"][-1]
        self.assertTrue(shown["rescued"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
