import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction


def run_cli(args, payload):
    proc = subprocess.run(
        [sys.executable, "-m", "ridag"] + args,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=_repo_root(),
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _repo_root():
    import os
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestCLI(unittest.TestCase):
    def test_solve_quadratic(self):
        out = run_cli(["solve"], {
            "expression": {"sub": [{"pow": [{"var": "x"}, 2]}, {"const": 2}]},
            "variable": "x",
            "domain": {"lo": "-10", "hi": "10"},
            "eps": "1/1000000",
        })
        self.assertTrue(out["certificate_ok"], out["certificate_errors"])
        roots = [c for c in out["claims"] if c["status"] == "unique_root"]
        self.assertEqual(len(roots), 2)
        for r in roots:
            lo = Fraction(r["interval"]["lo"])
            hi = Fraction(r["interval"]["hi"])
            self.assertLessEqual(hi - lo, Fraction(1, 10 ** 6))
            # the interval must straddle a root of x^2 - 2
            self.assertLessEqual((lo * lo - 2) * (hi * hi - 2), 0)

    def test_solve_with_pole_and_verify_subcommand(self):
        out = run_cli(["solve"], {
            "expression": {"div": [{"sub": [{"var": "x"}, {"const": 1}]},
                                   {"sub": [{"var": "x"}, {"const": 3}]}]},
            "domain": {"lo": "-10", "hi": "10"},
        })
        self.assertTrue(out["certificate_ok"], out["certificate_errors"])
        holes = [c for c in out["claims"]
                 if c["evidence"].get("kind") == "hole"]
        self.assertEqual(len(holes), 1)
        self.assertEqual(holes[0]["interval"]["lo"], "3")
        # feed the certificate back into the verify subcommand
        chk = run_cli(["verify"], out["certificate"])
        self.assertTrue(chk["ok"], chk["errors"])

    def test_eval(self):
        out = run_cli(["eval"], {
            "expression": {"add": [{"pow": [{"var": "x"}, 2]}, {"const": 1}]},
            "env": {"x": {"lo": "-1", "hi": "2"}},
        })
        self.assertEqual(out["value"][0]["lo"], "1")
        self.assertEqual(out["value"][0]["hi"], "5")

    def test_eval_division_union(self):
        out = run_cli(["eval"], {
            "expression": {"div": [{"const": 1}, {"var": "x"}]},
            "env": {"x": {"lo": "-1", "hi": "1"}},
        })
        self.assertEqual(len(out["value"]), 2)
        self.assertTrue(out["open_denominators"])

    def test_cli_file_input(self):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump({"expression": {"var": "x"},
                       "env": {"x": {"lo": "1/3", "hi": "1/2"}}}, fh)
            path = fh.name
        proc = subprocess.run(
            [sys.executable, "-m", "ridag", "eval", path],
            capture_output=True, text=True, cwd=_repo_root(), timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["value"][0]["lo"], "1/3")


if __name__ == "__main__":
    unittest.main()
