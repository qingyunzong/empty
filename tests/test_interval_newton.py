import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from interval_newton import (
    MultipleRootError,
    find_roots,
    poly_eval,
    poly_eval_interval,
)


def poly_from_roots(roots):
    coeffs = [Fraction(1)]
    for r in roots:
        out = [Fraction(0)] * (len(coeffs) + 1)
        for i, c in enumerate(coeffs):
            out[i] += c
            out[i + 1] -= c * r
        coeffs = out
    return coeffs


def reference_bisection(coeffs, a, b, eps):
    """Plain interval-arithmetic bisection reference: no Newton steps, just
    range-based pruning, halving, and an exact endpoint sign check."""
    found = []
    stack = [(Fraction(a), Fraction(b))]
    eps = Fraction(eps)
    while stack:
        lo, hi = stack.pop()
        fx = poly_eval_interval(coeffs, (lo, hi))
        if fx[0] > 0 or fx[1] < 0:
            continue
        if hi - lo < eps:
            if poly_eval(coeffs, lo) * poly_eval(coeffs, hi) <= 0:
                found.append((lo, hi))
            continue
        mid = (lo + hi) / 2
        stack.append((lo, mid))
        stack.append((mid, hi))
    return sorted(found)


def run_cli(*args):
    return subprocess.run(
        [sys.executable, str(ROOT / "interval_newton.py"), *args],
        capture_output=True, text=True)


class CliCase(unittest.TestCase):
    def run_cli_with_coeffs(self, coeffs, interval, eps):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".txt", delete=False) as fh:
            fh.write(" ".join(str(c) for c in coeffs))
            path = fh.name
        return run_cli(path, interval, eps)


class TestCompareWithBisection(CliCase):
    def test_a_matches_reference_bisection(self):
        roots = [Fraction(-2), Fraction(1, 3), Fraction(5, 2)]
        coeffs = poly_from_roots(roots)
        eps = Fraction(1, 10 ** 6)
        newton = find_roots(coeffs, -3, 4, eps)
        reference = reference_bisection(coeffs, -3, 4, eps)
        self.assertEqual(len(newton), 3)
        self.assertEqual(len(newton), len(reference))
        for (nlo, nhi), (rlo, rhi) in zip(newton, reference):
            self.assertLessEqual(max(nlo, rlo), min(nhi, rhi),
                                 "Newton and reference intervals must overlap")
        for r in roots:
            hits = [iv for iv in newton if iv[0] <= r <= iv[1]]
            self.assertEqual(len(hits), 1)


class TestKnownRationalRoots(CliCase):
    def test_b_all_distinct_rational_roots_found(self):
        roots = [Fraction(-3), Fraction(1, 2), Fraction(7, 4), Fraction(2)]
        coeffs = poly_from_roots(roots)
        eps = Fraction(1, 10 ** 8)
        found = find_roots(coeffs, -4, 3, eps)
        self.assertEqual(len(found), len(roots))
        for lo, hi in found:
            self.assertLess(hi - lo, eps)
        for i in range(len(found) - 1):
            self.assertLess(found[i][1], found[i + 1][0],
                            "isolating intervals must be disjoint")
        for r in roots:
            hits = [iv for iv in found if iv[0] <= r <= iv[1]]
            self.assertEqual(len(hits), 1, "root %s isolated exactly once" % r)

    def test_root_exactly_at_bisection_midpoint(self):
        coeffs = poly_from_roots([Fraction(-1), Fraction(0), Fraction(2)])
        found = find_roots(coeffs, -4, 4, Fraction(1, 10 ** 6))
        self.assertEqual(len(found), 3)
        for r in (-1, 0, 2):
            self.assertTrue(any(lo <= r <= hi for lo, hi in found))

    def test_root_at_interval_endpoint(self):
        coeffs = poly_from_roots([Fraction(1), Fraction(3)])
        found = find_roots(coeffs, 1, 5, Fraction(1, 1000))
        self.assertEqual(len(found), 2)
        self.assertTrue(found[0][0] <= 1 <= found[0][1])


class TestFailureScenarios(CliCase):
    def test_c_no_root_interval_returns_empty(self):
        self.assertEqual(find_roots([1, 0, 1], -2, 2, Fraction(1, 100)), [])
        coeffs = poly_from_roots([Fraction(10), Fraction(20)])
        self.assertEqual(find_roots(coeffs, -1, 5, Fraction(1, 100)), [])

    def test_c_multiple_root_raises(self):
        with self.assertRaises(MultipleRootError):
            find_roots([1, -2, 1], 0, 2, Fraction(1, 100))
        coeffs = poly_from_roots([Fraction(1)] * 2 + [Fraction(-3)])
        with self.assertRaises(MultipleRootError):
            find_roots(coeffs, -4, 2, Fraction(1, 100))

    def test_c_multiple_root_outside_interval_is_fine(self):
        coeffs = poly_from_roots([Fraction(1), Fraction(1), Fraction(5)])
        found = find_roots(coeffs, 4, 6, Fraction(1, 1000))
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0][0] <= 5 <= found[0][1])

    def test_c_cli_exit_code_4_on_multiple_root(self):
        proc = self.run_cli_with_coeffs([1, -2, 1], "[0,2]", "1e-6")
        self.assertEqual(proc.returncode, 4)
        self.assertIn("multiple", proc.stderr.lower())

    def test_cli_success_outputs_json(self):
        coeffs = poly_from_roots([Fraction(-1), Fraction(2)])
        proc = self.run_cli_with_coeffs(coeffs, "[-2,3]", "1e-6")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(len(data), 2)
        for (lo, hi), r in zip(data, (-1, 2)):
            self.assertLessEqual(Fraction(lo), r)
            self.assertLessEqual(r, Fraction(hi))
            self.assertLess(Fraction(hi) - Fraction(lo), Fraction(1, 10 ** 6))


class TestTinyEps(CliCase):
    def test_d_exact_convergence_at_eps_1e_minus_30(self):
        roots = [Fraction(-2, 7), Fraction(1, 3), Fraction(4)]
        coeffs = poly_from_roots(roots)
        eps = Fraction(1, 10 ** 30)
        found = find_roots(coeffs, -1, 5, eps)
        self.assertEqual(len(found), 3)
        for lo, hi in found:
            self.assertLess(hi - lo, eps)
            self.assertLessEqual(poly_eval(coeffs, lo) * poly_eval(coeffs, hi), 0)
        for r in roots:
            self.assertTrue(any(lo <= r <= hi for lo, hi in found))

    def test_d_cli_with_1e_minus_30(self):
        coeffs = poly_from_roots([Fraction(1, 3)])
        proc = self.run_cli_with_coeffs(coeffs, "[-1,2]", "1e-30")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        (lo, hi), = json.loads(proc.stdout)
        lo, hi = Fraction(lo), Fraction(hi)
        self.assertLessEqual(lo, Fraction(1, 3))
        self.assertLessEqual(Fraction(1, 3), hi)
        self.assertLess(hi - lo, Fraction(1, 10 ** 30))


if __name__ == "__main__":
    unittest.main()
