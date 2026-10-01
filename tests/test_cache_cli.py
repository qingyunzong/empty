import json
import os
import subprocess
import sys
import tempfile
import unittest

from exactcalc import AlgebraicNumber, EvidenceCache, EvidenceError

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(request):
    proc = subprocess.run(
        [sys.executable, "-m", "exactcalc"],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    return json.loads(proc.stdout), proc.returncode


class TestEvidenceCache(unittest.TestCase):
    def make_cache(self):
        cache = EvidenceCache()
        alg = AlgebraicNumber([-2, 0, 1], 1, 2, cache=cache)
        self.assertEqual(alg.floor(), 1)
        self.assertEqual(alg.ceil(), 2)
        self.assertEqual(alg.round_half_even(), 1)
        return cache

    def test_checkpoint_roundtrip(self):
        cache = self.make_cache()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "checkpoint.json")
            cache.save(path)
            restored = EvidenceCache.load(path)
        # Results are served from the verified cache.
        alg = AlgebraicNumber([-2, 0, 1], 1, 2, cache=restored)
        self.assertEqual(alg.floor(), 1)
        self.assertEqual(alg.ceil(), 2)
        self.assertEqual(alg.round_half_even(), 1)

    def test_tampered_results_rejected(self):
        cache = self.make_cache()
        data = cache.to_json()
        for op in ("floor", "ceil", "round"):
            tampered = json.loads(json.dumps(data))
            tampered["entries"][0]["results"][op] += 1
            with self.assertRaises(EvidenceError, msg=op):
                EvidenceCache.from_json(tampered)

    def test_tampered_interval_rejected(self):
        cache = self.make_cache()
        data = cache.to_json()
        tampered = json.loads(json.dumps(data))
        tampered["entries"][0]["iso"] = {"lo": "2", "hi": "3"}  # no root inside
        with self.assertRaises(EvidenceError):
            EvidenceCache.from_json(tampered)

    def test_tampered_polynomial_rejected(self):
        cache = self.make_cache()
        data = cache.to_json()
        tampered = json.loads(json.dumps(data))
        tampered["entries"][0]["poly"] = [-3, 0, 1]  # sqrt3 does not match interval
        with self.assertRaises(EvidenceError):
            EvidenceCache.from_json(tampered)

    def test_tampered_refined_interval_rejected(self):
        cache = self.make_cache()
        data = cache.to_json()
        tampered = json.loads(json.dumps(data))
        # Refined interval escapes the certified isolating interval.
        tampered["entries"][0]["refined"] = {"lo": "0", "hi": "5/2"}
        with self.assertRaises(EvidenceError):
            EvidenceCache.from_json(tampered)

    def test_malformed_checkpoint_rejected(self):
        with self.assertRaises(EvidenceError):
            EvidenceCache.from_json({"version": 2, "entries": []})
        with self.assertRaises(EvidenceError):
            EvidenceCache.from_json({"version": 1, "entries": [{"poly": [1]}]})


class TestCli(unittest.TestCase):
    def test_int_root_and_verify(self):
        m = 10 ** 6 + 3
        n = m ** 7
        resp, code = run_cli({"cmd": "int_root", "n": str(n), "k": 7})
        self.assertEqual(code, 0)
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["r"], m)
        ev = resp["evidence"]
        resp2, _ = run_cli({"cmd": "verify_root", "evidence": ev})
        self.assertTrue(resp2["valid"])
        # Tampered evidence must be rejected.
        resp3, _ = run_cli({"cmd": "verify_root", "evidence": {**ev, "r": m + 1}})
        self.assertFalse(resp3["valid"])
        resp4, _ = run_cli({"cmd": "verify_root", "evidence": {**ev, "n": n - 1}})
        self.assertFalse(resp4["valid"])

    def test_negative_odd_root(self):
        resp, _ = run_cli({"cmd": "int_root", "n": -9, "k": 3})
        self.assertEqual(resp["r"], -3)
        resp, _ = run_cli({"cmd": "int_root", "n": -16, "k": 2})
        self.assertFalse(resp["ok"])

    def test_floor_ceil_round_budget_zero(self):
        spec = {"poly": [-2, 0, 1], "lo": "1", "hi": "2", "budget": 0}
        for cmd, want in (("floor", 1), ("ceil", 2), ("round", 1)):
            resp, code = run_cli({"cmd": cmd, **spec})
            self.assertTrue(resp["ok"], resp)
            self.assertEqual(resp["result"], want, cmd)

    def test_round_tie_and_scaled(self):
        resp, _ = run_cli({"cmd": "round", "exact": "-5/2"})
        self.assertEqual(resp["result"], -2)
        resp, _ = run_cli({"cmd": "round", "exact": "7/2"})
        self.assertEqual(resp["result"], 4)
        resp, _ = run_cli({"cmd": "round", "poly": [-2, 0, 1], "lo": "1", "hi": "2",
                           "scale": ["3", "2"]})
        self.assertEqual(resp["result"], 2)

    def test_isolate_and_compare(self):
        resp, _ = run_cli({"cmd": "isolate", "poly": [0, -2, 0, 1]})
        self.assertEqual(len(resp["roots"]), 3)
        a = {"poly": [-2, 0, 1], "lo": "1", "hi": "2"}
        b = {"poly": [6, 0, -5, 0, 1], "lo": "1", "hi": "3/2"}  # same sqrt2
        c = {"poly": [6, 0, -5, 0, 1], "lo": "3/2", "hi": "2"}  # sqrt3
        resp, _ = run_cli({"cmd": "compare", "a": a, "b": b})
        self.assertEqual(resp["result"], 0)
        resp, _ = run_cli({"cmd": "compare", "a": a, "b": c})
        self.assertEqual(resp["result"], -1)

    def test_cache_file_checkpoint_via_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            req = {"cmd": "floor", "poly": [-2, 0, 1], "lo": "1", "hi": "2",
                   "cache_file": path}
            resp, code = run_cli(req)
            self.assertTrue(resp["ok"], resp)
            self.assertTrue(os.path.exists(path))
            # Second run loads and verifies the checkpoint.
            resp2, code2 = run_cli(req)
            self.assertTrue(resp2["ok"], resp2)
            self.assertEqual(resp2["result"], 1)
            # Corrupt the checkpoint: the CLI must refuse to use it.
            with open(path) as fh:
                data = json.load(fh)
            data["entries"][0]["results"]["floor"] = 5
            with open(path, "w") as fh:
                json.dump(data, fh)
            resp3, code3 = run_cli(req)
            self.assertFalse(resp3["ok"])
            self.assertIn("EvidenceError", resp3["error"])

    def test_unknown_command(self):
        resp, code = run_cli({"cmd": "bogus"})
        self.assertFalse(resp["ok"])
        self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
