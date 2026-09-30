import json
import subprocess
import sys
import unittest

from polygcd import poly


def run_cli(request):
    proc = subprocess.run(
        [sys.executable, "-m", "polygcd"],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, json.loads(proc.stdout)


class TestCli(unittest.TestCase):
    def test_gcd_with_bezout(self):
        d = [5, -2, 1]
        f = poly.mul(d, [1, 1])
        g = poly.mul(d, [3, 1])
        code, out = run_cli({
            "op": "gcd",
            "f": [str(c) for c in f],
            "g": [str(c) for c in g],
            "include_bezout": True,
        })
        self.assertEqual(code, 0)
        self.assertEqual(out["status"], "ok")
        self.assertEqual([int(c) for c in out["gcd"]], d)
        self.assertTrue(out["bezout_selfcheck"])
        code, chk = run_cli({
            "op": "verify_bezout",
            "f": [str(c) for c in f],
            "g": [str(c) for c in g],
            "certificate": out["bezout"],
        })
        self.assertEqual(code, 0)
        self.assertTrue(chk["valid"])

    def test_budget_and_resume_via_cli(self):
        huge = [10 ** 50 + 99, -4, 9]
        f = poly.mul(huge, [1, 1])
        g = poly.mul(huge, [2, 1])
        code, first = run_cli({
            "op": "gcd", "f": f, "g": g, "budget": 1,
        })
        self.assertEqual(first["status"], "budget_exhausted")
        self.assertIn("state", first)
        code, second = run_cli({
            "op": "gcd", "f": f, "g": g, "budget": 50,
            "state": first["state"],
        })
        self.assertEqual(second["status"], "ok")
        self.assertEqual([int(c) for c in second["gcd"]],
                         poly.normalize_primitive(huge))

    def test_content_pp_and_euclid(self):
        code, out = run_cli({"op": "content_pp", "f": ["6", "-10", "14"]})
        self.assertEqual(out["content"], "2")
        self.assertEqual(out["primitive_part"], ["3", "-5", "7"])
        code, out = run_cli({"op": "euclid_gcd", "f": [1, 2, 1], "g": [1, 1]})
        self.assertEqual(out["gcd"], ["1", "1"])

    def test_error_paths(self):
        code, out = run_cli({"op": "gcd", "f": [], "g": []})
        self.assertEqual(code, 2)
        self.assertIn("error", out)
        code, out = run_cli({"op": "nonsense"})
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
