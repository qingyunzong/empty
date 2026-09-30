import os
import tempfile
import unittest

from propcore.runner import run_spec


def make_spec(properties):
    return {"properties": properties}


def prop(name, gen, expr):
    return {"name": name, "gen": gen, "expr": expr}


class DeterminismTests(unittest.TestCase):
    def test_same_seed_identical_result(self):
        spec = make_spec([
            prop("ints", {"type": "int", "min": -10, "max": 10},
                 "value * value < 25"),
            prop("lists", {"type": "list",
                           "of": {"type": "int", "min": 0, "max": 5},
                           "min_len": 0, "max_len": 4},
                 "sum(value) < 6"),
        ])
        first = run_spec(spec, runs=80, seed=42)
        second = run_spec(spec, runs=80, seed=42)
        self.assertEqual(first, second)

    def test_different_seeds_usually_differ(self):
        spec = make_spec([prop("p", {"type": "int", "min": 0, "max": 10},
                               "value < 5")])
        results = {run_spec(spec, runs=30, seed=s)["failures"][0]["original"]
                   for s in range(5)}
        self.assertGreater(len(results), 1)


class FailureKindTests(unittest.TestCase):
    def test_error_and_property_fail_are_separate(self):
        spec = make_spec([
            prop("falsy", {"type": "int", "min": 0, "max": 3}, "value < 0"),
            prop("boom", {"type": "int", "min": 0, "max": 3}, "value[0]"),
        ])
        result = run_spec(spec, runs=10, seed=1)
        self.assertEqual(result["status"], "FAIL")
        kinds = {f["property"]: f["kind"] for f in result["failures"]}
        self.assertEqual(kinds["falsy"], "PROPERTY_FAIL")
        self.assertEqual(kinds["boom"], "ERROR")
        boom = next(f for f in result["failures"] if f["property"] == "boom")
        self.assertIn("TypeError", boom["error"])
        self.assertEqual(boom["value"], 0)  # errors shrink too

    def test_new_failure_has_priority_over_known_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "cache.json")
            known_spec = make_spec([
                prop("known", {"type": "int", "min": 4, "max": 4}, "value < 4"),
            ])
            first = run_spec(known_spec, runs=3, seed=1, db_path=db)
            self.assertEqual(first["status"], "FAIL")

            combined = make_spec([
                prop("known", {"type": "int", "min": 4, "max": 4}, "value < 4"),
                prop("fresh", {"type": "int", "min": 8, "max": 8}, "value < 8"),
            ])
            second = run_spec(combined, runs=3, seed=1, db_path=db)
            self.assertEqual(second["status"], "FAIL")  # new beats KNOWN_FAIL
            by_name = {f["property"]: f for f in second["failures"]}
            self.assertIs(by_name["known"]["known"], True)
            self.assertIs(by_name["fresh"]["known"], False)

    def test_all_known_gives_known_fail_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "cache.json")
            spec = make_spec([
                prop("p", {"type": "int", "min": 4, "max": 4}, "value < 4"),
            ])
            run_spec(spec, runs=3, seed=1, db_path=db)
            again = run_spec(spec, runs=3, seed=1, db_path=db)
            self.assertEqual(again["status"], "KNOWN_FAIL")

    def test_runs_counts_every_property(self):
        spec = make_spec([
            prop("a", {"type": "int", "min": 0, "max": 1}, "True"),
            prop("b", {"type": "int", "min": 0, "max": 1}, "True"),
        ])
        result = run_spec(spec, runs=7, seed=0)
        self.assertEqual(result["runs"], 14)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["failures"], [])
        self.assertEqual(result["shrinks"], 0)


if __name__ == "__main__":
    unittest.main()
