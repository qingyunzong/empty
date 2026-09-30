import json
import os
import tempfile
import unittest
from unittest import mock

import propcore.runner as runner
from propcore.cache import Cache, make_key
from propcore.generators import GEN_VERSION

FIXED_GEN = {"type": "int", "min": 4, "max": 4}
SPEC = {"properties": [{"name": "p", "gen": FIXED_GEN, "expr": "value < 4"}]}


def make_spec(gen, expr, name="p"):
    return {"properties": [{"name": name, "gen": gen, "expr": expr}]}


class CacheTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "cache.json")


class AcceptanceBCacheReconfirmTests(CacheTestBase):
    """B: a cache hit still re-runs the property once to confirm."""

    def test_hit_reconfirms_and_reports_known_fail(self):
        first = runner.run_spec(SPEC, runs=5, seed=1, db_path=self.db)
        self.assertEqual(first["status"], "FAIL")
        self.assertTrue(os.path.exists(self.db))

        calls = []
        real_evaluate = runner.evaluate

        def spy(code, value):
            calls.append(value)
            return real_evaluate(code, value)

        with mock.patch.object(runner, "evaluate", spy):
            second = runner.run_spec(SPEC, runs=5, seed=1, db_path=self.db)

        self.assertEqual(second["status"], "KNOWN_FAIL")
        self.assertEqual(len(second["failures"]), 1)
        self.assertIs(second["failures"][0]["known"], True)
        self.assertEqual(second["shrinks"], 0)  # skipped, not re-shrunk
        # Every generated value (always 4) hit the cache and was confirmed
        # exactly once; no shrink evaluations happened.
        self.assertEqual(calls, [4] * 5)

    def test_stale_entry_is_discarded_when_value_now_passes(self):
        key = make_key("p", FIXED_GEN, "value < 4", GEN_VERSION, 4)
        cache = Cache(self.db)
        cache.add(key, {"property": "p", "kind": "PROPERTY_FAIL", "value": 4})
        cache.save()

        with mock.patch.object(runner, "evaluate", return_value=("pass", None)):
            result = runner.run_spec(SPEC, runs=3, seed=1, db_path=self.db)
        self.assertEqual(result["status"], "PASS")
        self.assertNotIn(key, Cache(self.db).entries)


class AcceptanceCGeneratorVersionTests(CacheTestBase):
    """C: changing the generator version invalidates old cache entries."""

    def test_old_version_entries_are_not_hit(self):
        gen = {"type": "int", "min": 0, "max": 9}
        spec = make_spec(gen, "value < 3")
        stale_key = make_key("p", gen, "value < 3", "0", 3)
        with open(self.db, "w", encoding="utf-8") as handle:
            json.dump({"format": 1, "failures": {stale_key: {
                "property": "p", "kind": "PROPERTY_FAIL", "value": 3,
            }}}, handle)

        result = runner.run_spec(spec, runs=30, seed=1, db_path=self.db)
        # The stale entry is ignored, so the failure is rediscovered as new.
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(len(result["failures"]), 1)
        self.assertIs(result["failures"][0]["known"], False)
        self.assertEqual(result["failures"][0]["value"], 3)

        saved = Cache(self.db)
        fresh_key = make_key("p", gen, "value < 3", GEN_VERSION, 3)
        self.assertIn(fresh_key, saved.entries)
        self.assertNotEqual(fresh_key, stale_key)


class CacheIsolationTests(CacheTestBase):
    def test_cache_does_not_change_generation_sequence(self):
        gen = {"type": "int", "min": 0, "max": 9}
        spec = make_spec(gen, "value < 3")
        plain = runner.run_spec(spec, runs=60, seed=7, db_path=None)
        cached = runner.run_spec(spec, runs=60, seed=7, db_path=self.db)
        self.assertEqual(plain["runs"], cached["runs"])
        self.assertEqual(
            [f["value"] for f in plain["failures"]],
            [f["value"] for f in cached["failures"]],
        )
        # Second run with the populated cache: same sequence, now known.
        again = runner.run_spec(spec, runs=60, seed=7, db_path=self.db)
        self.assertEqual(again["status"], "KNOWN_FAIL")
        self.assertEqual(
            [f["value"] for f in plain["failures"]],
            [f["value"] for f in again["failures"]],
        )

    def test_corrupt_cache_file_is_ignored(self):
        with open(self.db, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        result = runner.run_spec(SPEC, runs=3, seed=1, db_path=self.db)
        self.assertEqual(result["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
