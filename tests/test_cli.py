import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(request):
    proc = subprocess.run(
        [sys.executable, "-m", "realroots.cli"],
        input=json.dumps(request), capture_output=True, text=True, cwd=ROOT)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


class TestCliIsolate(unittest.TestCase):
    def test_isolate_with_certificate(self):
        resp = run_cli({"cmd": "isolate", "polynomial": [-2, 0, 1],
                        "eps": "1/32", "certificate": True})
        self.assertEqual(resp["status"], "ok")
        self.assertEqual(len(resp["roots"]), 2)
        ok = run_cli({"cmd": "verify", "certificate": resp["certificate"]})
        self.assertTrue(ok["valid"])

    def test_zero_polynomial(self):
        resp = run_cli({"cmd": "isolate", "polynomial": [0, 0]})
        self.assertEqual(resp["status"], "error")

    def test_constant_polynomial(self):
        resp = run_cli({"cmd": "isolate", "polynomial": [4]})
        self.assertEqual(resp["status"], "ok")
        self.assertEqual(resp["roots"], [])

    def test_float_coefficients_rejected(self):
        resp = run_cli({"cmd": "isolate", "polynomial": [-2.5, 0, 1]})
        self.assertEqual(resp["status"], "error")


class TestCliBudgetResume(unittest.TestCase):
    def test_segmented_cli_matches_continuous(self):
        poly = [-6, 11, -6, 1]  # (x-1)(x-2)(x-3)
        full = run_cli({"cmd": "isolate", "polynomial": poly, "eps": "1/64"})
        self.assertEqual(full["status"], "ok")

        resp = run_cli({"cmd": "isolate", "polynomial": poly,
                        "eps": "1/64", "budget": 2})
        self.assertEqual(resp["status"], "budget_exhausted")
        self.assertGreater(resp["pending"], 0)
        state = resp["state"]
        for _ in range(1000):
            resp = run_cli({"cmd": "resume", "state": state, "budget": 2})
            if resp["status"] == "ok":
                break
            self.assertEqual(resp["status"], "budget_exhausted")
            state = resp["state"]
        else:
            self.fail("did not finish")
        self.assertEqual(resp["roots"], full["roots"])
        self.assertEqual(resp["ops"], full["ops"])


class TestCliCompareAndRefine(unittest.TestCase):
    def test_compare_shared_root(self):
        # f = (x-1)(x-2) = x^2-3x+2 ; g = (x-2)(x-3) = x^2-5x+6
        resp = run_cli({
            "cmd": "compare",
            "a": {"polynomial": [2, -3, 1], "root": {"kind": "point", "value": 2}},
            "b": {"polynomial": [6, -5, 1],
                  "root": {"kind": "interval", "lo": "3/2", "hi": "5/2"}},
        })
        self.assertEqual(resp["status"], "ok")
        self.assertEqual(resp["relation"], "equal")

    def test_compare_order(self):
        resp = run_cli({
            "cmd": "compare",
            "a": {"polynomial": [2, -3, 1], "root": {"kind": "point", "value": 1}},
            "b": {"polynomial": [6, -5, 1], "root": {"kind": "point", "value": 3}},
        })
        self.assertEqual(resp["relation"], "less")

    def test_compare_reports_multiplicity(self):
        # (x-2)^3 = x^3 - 6x^2 + 12x - 8
        resp = run_cli({
            "cmd": "compare",
            "a": {"polynomial": [-8, 12, -6, 1],
                  "root": {"kind": "point", "value": 2}},
            "b": {"polynomial": [6, -5, 1], "root": {"kind": "point", "value": 2}},
        })
        self.assertEqual(resp["relation"], "equal")
        self.assertEqual(resp["a_multiplicity"], 3)
        self.assertEqual(resp["b_multiplicity"], 1)

    def test_refine(self):
        iso = run_cli({"cmd": "isolate", "polynomial": [-2, 0, 1]})
        pos = iso["roots"][1]
        resp = run_cli({"cmd": "refine", "polynomial": [-2, 0, 1],
                        "root": pos, "eps": "1/1048576"})
        self.assertEqual(resp["status"], "ok")
        from fractions import Fraction
        lo = Fraction(resp["root"]["lo"])
        hi = Fraction(resp["root"]["hi"])
        self.assertLessEqual(hi - lo, Fraction(1, 2 ** 20))
        self.assertLess(lo * lo, 2)
        self.assertGreater(hi * hi, 2)

    def test_unknown_command(self):
        resp = run_cli({"cmd": "bogus"})
        self.assertEqual(resp["status"], "error")


if __name__ == "__main__":
    unittest.main()
