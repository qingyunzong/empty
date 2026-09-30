import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "interval_newton", *args],
        capture_output=True, text=True, cwd=ROOT,
    )


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write_coeffs(self, text):
        path = self.dir / "coeffs.txt"
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_success_json_output(self):
        path = self.write_coeffs("1 0 -2\n")
        proc = run_cli(path, "[1,2]", "1/1000000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        (enc,) = json.loads(proc.stdout)
        lo, hi = Fraction(enc[0]), Fraction(enc[1])
        self.assertLess(hi - lo, Fraction(1, 10**6))
        self.assertLess(lo * lo, 2)
        self.assertGreater(hi * hi, 2)

    def test_four_argument_form(self):
        path = self.write_coeffs("1 0 -2")
        proc = run_cli(path, "1", "2", "0.001")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(json.loads(proc.stdout)), 1)

    def test_json_coefficient_file(self):
        path = self.write_coeffs("[1, 0, -2]")
        proc = run_cli(path, "1,2", "1e-6")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(json.loads(proc.stdout)), 1)

    def test_multiple_roots_exit_4(self):
        path = self.write_coeffs("1 -2 1")  # (x-1)^2
        proc = run_cli(path, "[0,2]", "1/100")
        self.assertEqual(proc.returncode, 4)
        self.assertIn("multiple", proc.stderr.lower())

    def test_zero_polynomial_exit_4(self):
        path = self.write_coeffs("0 0 0")
        proc = run_cli(path, "[0,1]", "1/100")
        self.assertEqual(proc.returncode, 4)

    def test_missing_file_exit_2(self):
        proc = run_cli(str(self.dir / "nope.txt"), "[0,1]", "1/10")
        self.assertEqual(proc.returncode, 2)

    def test_invalid_eps_exit_2(self):
        path = self.write_coeffs("1 0 -2")
        self.assertEqual(run_cli(path, "[1,2]", "0").returncode, 2)
        self.assertEqual(run_cli(path, "[1,2]", "-1/5").returncode, 2)

    def test_no_roots_empty_json(self):
        path = self.write_coeffs("1 0 1")  # x^2 + 1
        proc = run_cli(path, "[-1,1]", "1/1000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), [])

    def test_tiny_eps_cli(self):
        path = self.write_coeffs("1 0 -2")
        proc = run_cli(path, "[1,2]", "1e-30")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        (enc,) = json.loads(proc.stdout)
        lo, hi = Fraction(enc[0]), Fraction(enc[1])
        self.assertLess(hi - lo, Fraction(1, 10**30))
        self.assertLess(lo * lo, 2)
        self.assertGreater(hi * hi, 2)


if __name__ == "__main__":
    unittest.main()
