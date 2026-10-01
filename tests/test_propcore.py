import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import propcore
from propcore import engine
from propcore.cache import empty_db, load_db
from propcore.generators import generate, normalize_gen, order_key


def make_spec(props):
    return propcore.load_spec({"properties": props})


def reference_min(domain, pred):
    """Reference counterexample: minimal failing value by (size, JSON) order."""
    failing = [v for v in domain if not pred(v)]
    assert failing, "domain has no failing value"
    return min(failing, key=order_key)


class DeterminismTests(unittest.TestCase):
    def test_same_seed_same_sequence(self):
        gen = normalize_gen({
            "type": "list",
            "of": {"type": "int", "min": -5, "max": 5},
            "min_length": 0,
            "max_length": 4,
        })
        seq1 = [generate(gen, random.Random(11)) for _ in range(3)]
        seq2 = [generate(gen, random.Random(11)) for _ in range(3)]
        self.assertEqual(seq1, seq2)
        rng_a = [generate(gen, random.Random(11)) for _ in range(50)]
        rng_b = [generate(gen, random.Random(11)) for _ in range(50)]
        self.assertEqual(rng_a, rng_b)

    def test_full_run_is_deterministic(self):
        spec = make_spec([{
            "name": "p",
            "gen": {"type": "int", "min": 0, "max": 10},
            "expr": "value < 5",
        }])
        r1 = engine.run_spec(spec, 200, 11)
        r2 = engine.run_spec(spec, 200, 11)
        self.assertEqual(r1, r2)


class AcceptanceATests(unittest.TestCase):
    """Fixed properties must match reference enumeration on a small domain."""

    def test_int_property_matches_reference(self):
        spec = make_spec([{
            "name": "lt5",
            "gen": {"type": "int", "min": 0, "max": 10},
            "expr": "value < 5",
        }])
        expected = reference_min(range(0, 11), lambda v: v < 5)
        self.assertEqual(expected, 5)
        for seed in (0, 1, 7, 11, 42, 2024):
            report = engine.run_spec(spec, 200, seed)
            self.assertEqual(report["status"], "PROPERTY_FAIL")
            self.assertEqual(report["failures"][0]["counterexample"], expected)

    def test_list_property_matches_reference(self):
        domain = [[], [0], [1], [0, 0], [0, 1], [1, 0], [1, 1]]
        expected = reference_min(domain, lambda v: len(v) < 2)
        self.assertEqual(expected, [0, 0])
        spec = make_spec([{
            "name": "short",
            "gen": {
                "type": "list",
                "of": {"type": "int", "min": 0, "max": 1},
                "min_length": 0,
                "max_length": 2,
            },
            "expr": "len(value) < 2",
        }])
        for seed in (0, 3, 11, 99):
            report = engine.run_spec(spec, 200, seed)
            self.assertEqual(report["status"], "PROPERTY_FAIL")
            self.assertEqual(report["failures"][0]["counterexample"], expected)

    def test_dict_property_matches_reference(self):
        domain = [{"a": a, "b": b} for a in range(4) for b in range(4)]
        expected = reference_min(domain, lambda v: v["a"] < 2)
        self.assertEqual(expected, {"a": 2, "b": 0})
        spec = make_spec([{
            "name": "d",
            "gen": {
                "type": "dict",
                "fields": {
                    "a": {"type": "int", "min": 0, "max": 3},
                    "b": {"type": "int", "min": 0, "max": 3},
                },
            },
            "expr": "value['a'] < 2",
        }])
        for seed in (0, 5, 11, 77):
            report = engine.run_spec(spec, 200, seed)
            self.assertEqual(report["status"], "PROPERTY_FAIL")
            self.assertEqual(report["failures"][0]["counterexample"], expected)


class AcceptanceBTests(unittest.TestCase):
    """Cache hits must still re-confirm the cached counterexample once."""

    def test_cache_hit_reconfirms_and_reports_known_fail(self):
        calls = []

        def prop_fn(v):
            calls.append(v)
            return v < 5

        spec = make_spec([{
            "name": "p",
            "gen": {"type": "int", "min": 0, "max": 10},
            "fn": prop_fn,
        }])
        db = empty_db()
        first = engine.run_spec(spec, 200, 11, db)
        self.assertEqual(first["status"], "PROPERTY_FAIL")
        self.assertEqual(len(db["failures"]), 1)

        calls.clear()
        second = engine.run_spec(spec, 200, 11, db)
        self.assertEqual(second["status"], "KNOWN_FAIL")
        self.assertEqual(second["runs"], 0, "confirmed known failure skips runs")
        self.assertEqual(len(calls), 1, "cache hit must re-run once to confirm")
        self.assertEqual(calls[0], 5, "confirmation uses the cached counterexample")
        self.assertEqual(second["failures"][0]["kind"], "KNOWN_FAIL")
        self.assertEqual(second["failures"][0]["counterexample"], 5)


class AcceptanceCTests(unittest.TestCase):
    """Changing the generator version invalidates old cache entries."""

    def test_generator_change_ignores_old_cache(self):
        spec_v1 = make_spec([{
            "name": "p",
            "gen": {"type": "int", "min": 0, "max": 10},
            "expr": "value < 5",
        }])
        db = empty_db()
        engine.run_spec(spec_v1, 200, 11, db)
        self.assertEqual(len(db["failures"]), 1)
        old_key = next(iter(db["failures"]))

        spec_v2 = make_spec([{
            "name": "p",
            "gen": {"type": "int", "min": 0, "max": 20},
            "expr": "value < 5",
        }])
        report = engine.run_spec(spec_v2, 200, 11, db)
        self.assertEqual(report["status"], "PROPERTY_FAIL",
                         "changed generator must not hit the old cache entry")
        self.assertGreater(report["runs"], 0)
        self.assertIn(old_key, db["failures"], "old entry is left untouched")
        self.assertEqual(len(db["failures"]), 2, "new version gets its own key")

    def test_library_version_bump_invalidates(self):
        gen = normalize_gen({"type": "int", "min": 0, "max": 10})
        v1 = propcore.gen_version(gen)
        import propcore.generators as g
        saved = g.GEN_LIB_VERSION
        try:
            g.GEN_LIB_VERSION = "2"
            v2 = propcore.gen_version(gen)
        finally:
            g.GEN_LIB_VERSION = saved
        self.assertNotEqual(v1, v2)


class AcceptanceDTests(unittest.TestCase):
    """Tied minimal counterexamples must be chosen stably."""

    def test_tie_break_is_stable_across_seeds(self):
        # Failing values are exactly +2 and -2: same size, JSON order "-2" < "2".
        spec = make_spec([{
            "name": "tie",
            "gen": {"type": "int", "min": -5, "max": 5},
            "expr": "abs(value) != 2",
        }])
        for seed in range(25):
            report = engine.run_spec(spec, 200, seed)
            self.assertEqual(report["status"], "PROPERTY_FAIL")
            self.assertEqual(report["failures"][0]["counterexample"], -2,
                             "seed %d picked an unstable tie winner" % seed)


class SemanticsTests(unittest.TestCase):
    def test_error_is_separate_from_property_fail(self):
        spec = make_spec([{
            "name": "boom",
            "gen": {"type": "int", "min": 3, "max": 3},
            "expr": "1 / (value - 3) > 0",
        }])
        report = engine.run_spec(spec, 50, 11)
        self.assertEqual(report["status"], "ERROR")
        self.assertEqual(report["failures"][0]["kind"], "ERROR")
        self.assertEqual(report["failures"][0]["counterexample"], 3)

        spec_ok = make_spec([{
            "name": "plain",
            "gen": {"type": "int", "min": 0, "max": 10},
            "expr": "value < 100",
        }])
        report_ok = engine.run_spec(spec_ok, 50, 11)
        self.assertEqual(report_ok["status"], "PASS")
        self.assertEqual(report_ok["runs"], 50)
        self.assertEqual(report_ok["failures"], [])

    def test_cache_does_not_mask_new_failure(self):
        # First run caches counterexample 5 for "value < 5".
        behavior = {"fn": lambda v: v < 5}
        spec = make_spec([{
            "name": "p",
            "gen": {"type": "int", "min": 0, "max": 10},
            "fn": lambda v: behavior["fn"](v),
        }])
        db = empty_db()
        first = engine.run_spec(spec, 200, 11, db)
        self.assertEqual(first["status"], "PROPERTY_FAIL")
        self.assertEqual(len(db["failures"]), 1)

        # Property changes: cached value 5 now passes, but 7 fails. The stale
        # entry must be dropped and the new failure must be found.
        behavior["fn"] = lambda v: v != 7
        second = engine.run_spec(spec, 200, 11, db)
        self.assertEqual(second["status"], "PROPERTY_FAIL")
        self.assertGreater(second["runs"], 0)
        self.assertEqual(second["failures"][0]["counterexample"], 7)
        self.assertEqual(second["failures"][0]["kind"], "PROPERTY_FAIL")

    def test_new_failure_beats_known_fail(self):
        spec = make_spec([
            {
                "name": "known",
                "gen": {"type": "int", "min": 0, "max": 10},
                "expr": "value < 5",
            },
            {
                "name": "fresh",
                "gen": {"type": "int", "min": 0, "max": 10},
                "expr": "value < 8",
            },
        ])
        db = empty_db()
        key = engine.cache_key(spec["properties"][0])
        db["failures"][key] = {"kind": "PROPERTY_FAIL", "counterexample": 5}
        report = engine.run_spec(spec, 200, 11, db)
        self.assertEqual(report["status"], "PROPERTY_FAIL")
        kinds = {f["property"]: f["kind"] for f in report["failures"]}
        self.assertEqual(kinds["known"], "KNOWN_FAIL")
        self.assertEqual(kinds["fresh"], "PROPERTY_FAIL")

    def test_oneof_generation_and_shrink(self):
        spec = make_spec([{
            "name": "oo",
            "gen": {
                "type": "oneof",
                "choices": [
                    {"type": "int", "min": 0, "max": 3},
                    {"type": "int", "min": 10, "max": 13},
                ],
            },
            "expr": "value < 2 or value >= 10",
        }])
        report = engine.run_spec(spec, 200, 11)
        self.assertEqual(report["status"], "PROPERTY_FAIL")
        self.assertEqual(report["failures"][0]["counterexample"], 2)


class CliTests(unittest.TestCase):
    def run_cli(self, *args, cwd=None):
        env = dict(os.environ)
        env["PYTHONPATH"] = ROOT + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-m", "propcore", *args],
            capture_output=True, text=True, cwd=cwd or ROOT, env=env,
        )

    def test_cli_end_to_end_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec_path = os.path.join(tmp, "spec.json")
            db_path = os.path.join(tmp, "cache.json")
            with open(spec_path, "w") as fh:
                json.dump({
                    "properties": [{
                        "name": "lt5",
                        "gen": {"type": "int", "min": 0, "max": 10},
                        "expr": "value < 5",
                    }]
                }, fh)

            proc = self.run_cli("test", spec_path, "--runs", "200",
                                "--seed", "11", "--db", db_path)
            self.assertEqual(proc.returncode, 1, proc.stderr)
            report = json.loads(proc.stdout)
            self.assertEqual(report["status"], "PROPERTY_FAIL")
            self.assertGreater(report["runs"], 0)
            self.assertIn("shrinks", report)
            self.assertEqual(report["failures"][0]["counterexample"], 5)
            self.assertTrue(os.path.exists(db_path))

            proc2 = self.run_cli("test", spec_path, "--runs", "200",
                                 "--seed", "11", "--db", db_path)
            self.assertEqual(proc2.returncode, 0, proc2.stderr)
            report2 = json.loads(proc2.stdout)
            self.assertEqual(report2["status"], "KNOWN_FAIL")
            self.assertEqual(report2["runs"], 0)

    def test_cli_pass_exit_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec_path = os.path.join(tmp, "spec.json")
            with open(spec_path, "w") as fh:
                json.dump({
                    "properties": [{
                        "name": "ok",
                        "gen": {"type": "int", "min": 0, "max": 10},
                        "expr": "value <= 10",
                    }]
                }, fh)
            proc = self.run_cli("test", spec_path, "--runs", "200", "--seed", "11")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(proc.stdout)
            self.assertEqual(report["status"], "PASS")
            self.assertEqual(report["runs"], 200)
            self.assertEqual(report["failures"], [])
            self.assertEqual(report["shrinks"], 0)

    def test_invalid_spec_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            cases = {
                "missing.json": None,
                "badjson.json": "{not json",
                "badtype.json": json.dumps({"properties": [{
                    "name": "x",
                    "gen": {"type": "nope"},
                    "expr": "True",
                }]}),
                "badexpr.json": json.dumps({"properties": [{
                    "name": "x",
                    "gen": {"type": "int", "min": 0, "max": 1},
                    "expr": "value <",
                }]}),
                "badrange.json": json.dumps({"properties": [{
                    "name": "x",
                    "gen": {"type": "int", "min": 5, "max": 1},
                    "expr": "True",
                }]}),
            }
            for fname, content in cases.items():
                path = os.path.join(tmp, fname)
                if content is not None:
                    with open(path, "w") as fh:
                        fh.write(content)
                proc = self.run_cli("test", path)
                self.assertEqual(proc.returncode, 2,
                                 "%s should exit 2: %s" % (fname, proc.stdout))
                self.assertIn("error", proc.stderr.lower())

    def test_corrupt_db_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "cache.json")
            with open(db_path, "w") as fh:
                fh.write("{corrupt")
            self.assertEqual(load_db(db_path), empty_db())


if __name__ == "__main__":
    unittest.main()
