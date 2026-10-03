import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from asofjoin import AsofJoiner, run_join

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def brute_force(facts, dims, tol):
    """Reference: full-knowledge join.

    facts/dims are lists of dicts in file order.  Duplicate dids keep the
    record with the greatest ts; ties keep the earliest file arrival
    (mirrors the engine under ts-ordered ingestion).
    """
    by_did = {}
    for d in dims:
        cur = by_did.get(d["did"])
        if cur is None or d["ts"] > cur["ts"]:
            by_did[d["did"]] = d
    store = list(by_did.values())

    out = []
    for f in facts:
        cands = [d for d in store if d["key"] == f["key"] and d["ts"] <= f["ts"]]
        if not cands:
            out.append({"fid": f["fid"], "key": f["key"], "ts": f["ts"],
                        "did": None, "attr": None, "reason": "no_dim"})
            continue
        best = min(cands, key=lambda d: (-d["ts"], d["did"]))
        if f["ts"] - best["ts"] > tol:
            out.append({"fid": f["fid"], "key": f["key"], "ts": f["ts"],
                        "did": None, "attr": None, "reason": "stale"})
        else:
            out.append({"fid": f["fid"], "key": f["key"], "ts": f["ts"],
                        "did": best["did"], "attr": best["attr"], "reason": "ok"})
    out.sort(key=lambda o: (o["ts"], o["fid"]))
    return out


class TestBruteForceEnumeration(unittest.TestCase):
    """Acceptance 1: enumerate small cases (n <= 9) against brute force."""

    def test_random_small_cases_match_reference(self):
        rng = random.Random(20261004)
        cases = 0
        for _ in range(600):
            n_facts = rng.randint(0, 9)
            n_dims = rng.randint(0, 9 - n_facts)
            keys = ["a", "b"]
            # Unique dids here: duplicate-did override semantics are covered
            # by TestDimDedup; the full-knowledge reference cannot model
            # overrides that arrive after a fact was already emitted.
            dids = rng.sample([f"d{i}" for i in range(9)], n_dims)
            facts = [{"fid": f"f{i}", "key": rng.choice(keys),
                      "ts": rng.randint(0, 12)} for i in range(n_facts)]
            dims = [{"did": dids[i], "key": rng.choice(keys),
                     "ts": rng.randint(0, 12),
                     "attr": f"v{rng.randint(0, 99)}"}
                    for i in range(n_dims)]
            tol = rng.choice([0, 1, 3, 5, 20])
            expected = brute_force(facts, dims, tol)
            got = run_join(facts, dims, tol)
            self.assertEqual(got, expected,
                             msg=f"facts={facts} dims={dims} tol={tol}")
            cases += 1
        self.assertEqual(cases, 600)

    def test_deterministic_output_order(self):
        facts = [{"fid": "f2", "key": "a", "ts": 5},
                 {"fid": "f1", "key": "a", "ts": 5},
                 {"fid": "f0", "key": "a", "ts": 1}]
        got = run_join(facts, [], 10)
        self.assertEqual([(o["ts"], o["fid"]) for o in got],
                         [(1, "f0"), (5, "f1"), (5, "f2")])


class TestTieBreak(unittest.TestCase):
    """Acceptance 2: equal dim ts decided by smallest did."""

    def test_same_ts_picks_lexicographically_smallest_did(self):
        dims = [{"did": "dz", "key": "a", "ts": 10, "attr": "z"},
                {"did": "da", "key": "a", "ts": 10, "attr": "a"},
                {"did": "dm", "key": "a", "ts": 10, "attr": "m"}]
        facts = [{"fid": "f1", "key": "a", "ts": 10}]
        got = run_join(facts, dims, 5)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["did"], "da")
        self.assertEqual(got[0]["attr"], "a")
        self.assertEqual(got[0]["reason"], "ok")

    def test_tie_only_among_in_window_dims(self):
        dims = [{"did": "da", "key": "a", "ts": 1, "attr": "old"},
                {"did": "dz", "key": "a", "ts": 9, "attr": "new"}]
        facts = [{"fid": "f1", "key": "a", "ts": 10}]
        got = run_join(facts, dims, 5)
        self.assertEqual(got[0]["did"], "dz")


class TestLateDimTiming(unittest.TestCase):
    """Acceptance 3: a dim arriving late but inside tol changes the result."""

    def test_late_dim_updates_pending_fact(self):
        j = AsofJoiner(tol=20)
        j.add_dim("d_old", "k", 75, "old")       # DWM=75, outside window of ts=100
        j.add_fact("f1", "k", 100)               # DWM(75) <= 100-20 -> stays pending
        self.assertEqual(j.results(), [])
        self.assertEqual(j.pending_count, 1)
        j.add_dim("d_new", "k", 85, "new")       # late dim, DWM=85 > 80
        self.assertEqual(j.results(), [])        # FWM(100) not > 100 yet
        j.add_fact("f2", "k", 200)               # FWM=200 > 100 -> f1 emits
        out = j.results()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["fid"], "f1")
        self.assertEqual(out[0]["did"], "d_new")
        self.assertEqual(out[0]["attr"], "new")
        self.assertEqual(out[0]["reason"], "ok")

    def test_without_late_dim_fact_would_be_stale(self):
        j = AsofJoiner(tol=20)
        j.add_dim("d_old", "k", 75, "old")
        j.add_fact("f1", "k", 100)
        j.add_dim("d_other", "other", 81, "x")   # advances DWM past 80, wrong key
        j.add_fact("f2", "k", 200)               # advances FWM past 100
        out = j.results()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["fid"], "f1")
        self.assertEqual(out[0]["reason"], "stale")
        self.assertIsNone(out[0]["attr"])

    def test_out_of_order_dims_file_still_joins(self):
        dims = [{"did": "d1", "key": "a", "ts": 100, "attr": "hi"},
                {"did": "d2", "key": "a", "ts": 40, "attr": "lo"}]
        facts = [{"fid": "f1", "key": "a", "ts": 55}]
        got = run_join(facts, dims, 20)
        self.assertEqual(got[0]["did"], "d2")
        self.assertEqual(got[0]["attr"], "lo")

    def test_missing_dim_not_prematurely_unsatisfiable(self):
        j = AsofJoiner(tol=10)
        j.add_fact("f1", "k", 100)               # no dims at all yet
        self.assertEqual(j.results(), [])        # must not emit no_dim yet
        j.add_dim("d1", "k", 95, "v")            # dim arrives, in window (DWM ok)
        self.assertEqual(j.results(), [])        # FWM(100) not > 100 yet
        j.add_fact("f2", "k", 200)               # FWM passes -> f1 emits
        out = j.results()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["fid"], "f1")
        self.assertEqual(out[0]["reason"], "ok")
        self.assertEqual(out[0]["attr"], "v")


class TestStaleVsNoDim(unittest.TestCase):
    """Acceptance 4: stale and no_dim are distinguished."""

    def test_no_dim_when_key_never_seen(self):
        got = run_join([{"fid": "f1", "key": "x", "ts": 10}],
                       [{"did": "d1", "key": "y", "ts": 1, "attr": "v"}], 5)
        self.assertEqual(got[0]["reason"], "no_dim")
        self.assertIsNone(got[0]["did"])
        self.assertIsNone(got[0]["attr"])

    def test_no_dim_when_only_future_dims(self):
        got = run_join([{"fid": "f1", "key": "x", "ts": 10}],
                       [{"did": "d1", "key": "x", "ts": 50, "attr": "v"}], 100)
        self.assertEqual(got[0]["reason"], "no_dim")

    def test_stale_when_newest_dim_too_old(self):
        got = run_join([{"fid": "f1", "key": "x", "ts": 100}],
                       [{"did": "d1", "key": "x", "ts": 10, "attr": "v"}], 20)
        self.assertEqual(got[0]["reason"], "stale")
        self.assertIsNone(got[0]["attr"])

    def test_boundary_age_equal_tol_matches(self):
        got = run_join([{"fid": "f1", "key": "x", "ts": 100}],
                       [{"did": "d1", "key": "x", "ts": 80, "attr": "v"}], 20)
        self.assertEqual(got[0]["reason"], "ok")

    def test_boundary_age_tol_plus_one_is_stale(self):
        got = run_join([{"fid": "f1", "key": "x", "ts": 100}],
                       [{"did": "d1", "key": "x", "ts": 79, "attr": "v"}], 20)
        self.assertEqual(got[0]["reason"], "stale")


class TestWatermarkSemantics(unittest.TestCase):
    def test_fact_not_emitted_until_fwm_passes(self):
        j = AsofJoiner(tol=10)
        j.add_dim("d1", "k", 1000, "v")          # DWM huge
        j.add_fact("f1", "k", 100)               # FWM=100, not > 100 -> pending
        self.assertEqual(j.results(), [])
        j.add_fact("f2", "k", 200)               # FWM=200 > 100 -> f1 emits
        self.assertEqual([o["fid"] for o in j.results()], ["f1"])
        j.flush()
        self.assertEqual([o["fid"] for o in j.results()], ["f1", "f2"])

    def test_fact_not_emitted_until_dwm_passes(self):
        j = AsofJoiner(tol=10)
        j.add_fact("f1", "k", 100)
        j.add_fact("f2", "k", 200)               # FWM ok, but no dim yet
        self.assertEqual(j.results(), [])
        j.add_dim("d1", "k", 91, "v")            # DWM=91 > 90 -> f1 emits
        self.assertEqual([o["fid"] for o in j.results()], ["f1"])

    def test_late_fact_dropped(self):
        j = AsofJoiner(tol=10)
        j.add_fact("f1", "k", 100)
        j.add_fact("f2", "k", 50)                # 50 < FWM=100 -> dropped
        self.assertEqual(j.dropped_facts, 1)
        j.flush()
        self.assertEqual([o["fid"] for o in j.results()], ["f1"])

    def test_fact_with_ts_equal_fwm_kept(self):
        j = AsofJoiner(tol=10)
        j.add_fact("f1", "k", 100)
        j.add_fact("f2", "k", 100)
        self.assertEqual(j.dropped_facts, 0)
        j.flush()
        self.assertEqual(len(j.results()), 2)


class TestDimDedup(unittest.TestCase):
    def test_later_arrival_with_higher_ts_overrides(self):
        j = AsofJoiner(tol=100)
        j.add_dim("d1", "k", 10, "first")
        j.add_dim("d1", "k", 20, "second")
        j.add_fact("f1", "k", 25)
        j.flush()
        out = j.results()
        self.assertEqual(out[0]["attr"], "second")
        self.assertEqual(j.ignored_dims, 0)

    def test_same_ts_later_arrival_invalid(self):
        j = AsofJoiner(tol=100)
        j.add_dim("d1", "k", 20, "first")
        j.add_dim("d1", "k", 20, "second")
        j.add_fact("f1", "k", 25)
        j.flush()
        out = j.results()
        self.assertEqual(out[0]["attr"], "first")
        self.assertEqual(j.ignored_dims, 1)

    def test_lower_ts_later_arrival_no_effect(self):
        j = AsofJoiner(tol=100)
        j.add_dim("d1", "k", 20, "new")
        j.add_dim("d1", "k", 10, "old")
        j.add_fact("f1", "k", 25)
        j.flush()
        self.assertEqual(j.results()[0]["attr"], "new")

    def test_override_removes_old_record_from_join(self):
        j = AsofJoiner(tol=5)
        j.add_dim("d1", "k", 10, "old")
        j.add_dim("d1", "k", 100, "new")         # overrides; ts=10 record gone
        j.add_fact("f1", "k", 12)                # window [7,12]: nothing left
        j.flush()
        self.assertEqual(j.results()[0]["reason"], "no_dim")


class TestValidation(unittest.TestCase):
    def test_negative_tol_rejected(self):
        with self.assertRaises(ValueError):
            AsofJoiner(-1)

    def test_zero_tol_requires_exact_ts(self):
        got = run_join([{"fid": "f1", "key": "x", "ts": 10}],
                       [{"did": "d1", "key": "x", "ts": 9, "attr": "a"},
                        {"did": "d2", "key": "x", "ts": 10, "attr": "b"}], 0)
        self.assertEqual(got[0]["did"], "d2")
        self.assertEqual(got[0]["reason"], "ok")


class TestCli(unittest.TestCase):
    def _run_cli(self, facts_lines, dim_lines, tol):
        tmp = tempfile.mkdtemp()
        fpath = os.path.join(tmp, "facts.jsonl")
        dpath = os.path.join(tmp, "dim.jsonl")
        with open(fpath, "w", encoding="utf-8") as fh:
            fh.write("".join(facts_lines))
        with open(dpath, "w", encoding="utf-8") as fh:
            fh.write("".join(dim_lines))
        return subprocess.run(
            [sys.executable, "-m", "asofjoin", "--facts", fpath,
             "--dim", dpath, "--tol", str(tol)],
            capture_output=True, text=True, cwd=REPO_ROOT)

    def test_cli_happy_path(self):
        proc = self._run_cli(
            ['{"fid":"f1","key":"a","ts":160}\n',
             '{"fid":"f2","key":"a","ts":400}\n',
             '{"fid":"f3","key":"c","ts":10}\n'],
            ['{"did":"d1","key":"a","ts":100,"attr":"x"}\n',
             '{"did":"d2","key":"a","ts":150,"attr":"y"}\n'],
            100)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([(r["fid"], r["reason"]) for r in rows],
                         [("f3", "no_dim"), ("f1", "ok"), ("f2", "stale")])
        self.assertEqual(rows[1]["attr"], "y")
        self.assertIsNone(rows[0]["attr"])

    def test_cli_bad_json_line_exit2(self):
        proc = self._run_cli(['{"fid":"f1","key":"a","ts":1}\n',
                              'not json\n'], [], 10)
        self.assertEqual(proc.returncode, 2)

    def test_cli_missing_field_exit2(self):
        proc = self._run_cli(['{"fid":"f1","ts":1}\n'], [], 10)
        self.assertEqual(proc.returncode, 2)

    def test_cli_dim_missing_attr_exit2(self):
        proc = self._run_cli([], ['{"did":"d1","key":"a","ts":1}\n'], 10)
        self.assertEqual(proc.returncode, 2)

    def test_cli_bad_ts_type_exit2(self):
        proc = self._run_cli(['{"fid":"f1","key":"a","ts":"1"}\n'], [], 10)
        self.assertEqual(proc.returncode, 2)

    def test_cli_negative_tol_exit2(self):
        proc = self._run_cli([], [], -1)
        self.assertEqual(proc.returncode, 2)

    def test_cli_missing_file_exit2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "asofjoin", "--facts", "/nonexistent/f.jsonl",
             "--dim", "/nonexistent/d.jsonl", "--tol", "1"],
            capture_output=True, text=True, cwd=REPO_ROOT)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
