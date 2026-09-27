import random
import subprocess
import sys
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import calc

ROOT = Path(__file__).resolve().parent.parent


def reference_round(v: Fraction, p: int, mode: str) -> Fraction:
    """Independent manual Fraction-based rounding reference.

    Written separately from calc.round_fraction: finds the decimal
    exponent by repeated multiplication/division and rounds via divmod
    on the scaled numerator/denominator.
    """
    assert p > 0 and mode in calc.MODES
    if v == 0:
        return Fraction(0)
    sign = 1 if v > 0 else -1
    a = abs(v)
    # exponent e: 10**e <= a < 10**(e+1), found by stepping.
    e = 0
    while a < Fraction(10) ** e if e <= 0 else a < Fraction(10 ** e):
        e -= 1
    while True:
        hi = Fraction(10 ** (e + 1)) if e + 1 > 0 else Fraction(10) ** (e + 1)
        if a < hi:
            break
        e += 1
    while True:
        lo = Fraction(10 ** e) if e >= 0 else Fraction(1, 10 ** (-e))
        if a >= lo:
            break
        e -= 1
    k = p - 1 - e
    # scaled = a * 10**k as an exact quotient num/den.
    if k >= 0:
        num, den = a.numerator * 10 ** k, a.denominator
    else:
        num, den = a.numerator, a.denominator * 10 ** (-k)
    q, r = divmod(num, den)
    if mode == "DOWN":
        m = q
    elif mode == "FLOOR":
        # floor of the signed value: negative values round away from zero.
        m = q if (r == 0 or sign > 0) else q + 1
    else:
        cmp = 2 * r - den
        if cmp > 0:
            m = q + 1
        elif cmp < 0:
            m = q
        elif mode == "HALF_UP":
            m = q + 1
        else:  # HALF_EVEN
            m = q + 1 if q % 2 == 1 else q
    if k >= 0:
        return Fraction(sign * m, 10 ** k)
    return Fraction(sign * m * 10 ** (-k))


class RandomOpsReferenceTest(unittest.TestCase):
    """(a) Random rational ops vs manual Fraction-based reference."""

    def test_random_ops_all_modes(self):
        rng = random.Random(20260928)
        for i in range(600):
            a = Fraction(rng.randint(-10**6, 10**6), rng.randint(1, 10**6))
            b = Fraction(rng.randint(-10**6, 10**6), rng.randint(1, 10**6))
            op = rng.choice("+-*/")
            if op == "+":
                v = a + b
            elif op == "-":
                v = a - b
            elif op == "*":
                v = a * b
            else:
                if b == 0:
                    continue
                v = a / b
            p = rng.randint(1, 25)
            mode = rng.choice(calc.MODES)
            got = calc.round_fraction(v, p, mode)
            want = reference_round(v, p, mode)
            self.assertEqual(got, want, f"{v} p={p} {mode}: got {got} want {want}")

    def test_random_cli_expressions(self):
        rng = random.Random(7)
        for _ in range(100):
            a = Fraction(rng.randint(-1000, 1000), rng.randint(1, 1000))
            b = Fraction(rng.randint(1, 1000), rng.randint(1, 1000))
            op = rng.choice("+-*/")
            expr = f"({a.numerator}/{a.denominator}) {op} ({b.numerator}/{b.denominator})"
            p = rng.randint(1, 15)
            mode = rng.choice(calc.MODES)
            exact = calc.evaluate(expr, p, mode)
            want = reference_round(exact, p, mode)
            self.assertEqual(calc.run(expr, p, mode), calc.format_decimal(want, p))


class TieCaseTest(unittest.TestCase):
    """(b) Exact halfway ties."""

    def test_half_even_tie_to_even(self):
        self.assertEqual(calc.run("2.5", 1, "HALF_EVEN"), "2")
        self.assertEqual(calc.run("3.5", 1, "HALF_EVEN"), "4")
        self.assertEqual(calc.run("0.45", 1, "HALF_EVEN"), "0.4")
        self.assertEqual(calc.run("0.55", 1, "HALF_EVEN"), "0.6")
        self.assertEqual(calc.run("1.5", 1, "HALF_EVEN"), "2")

    def test_half_up_tie_away_from_zero(self):
        self.assertEqual(calc.run("2.5", 1, "HALF_UP"), "3")
        self.assertEqual(calc.run("-2.5", 1, "HALF_UP"), "-3")

    def test_fraction_tie(self):
        # 5/2 == 2.5 exactly, no decimal literal involved.
        self.assertEqual(calc.run("5/2", 1, "HALF_EVEN"), "2")
        self.assertEqual(calc.run("5/2", 1, "HALF_UP"), "3")

    def test_sqrt_exact_tie(self):
        # sqrt(6.25) == 2.5 exactly -> tie at p=1.
        self.assertEqual(calc.run("sqrt(6.25)", 1, "HALF_EVEN"), "2")
        self.assertEqual(calc.run("sqrt(6.25)", 1, "HALF_UP"), "3")


class NegativeModeTest(unittest.TestCase):
    """(c) DOWN (toward zero) vs FLOOR (toward -inf) on negatives."""

    def test_down_truncates_toward_zero(self):
        self.assertEqual(calc.run("-2.5", 1, "DOWN"), "-2")
        self.assertEqual(calc.run("-2.9", 1, "DOWN"), "-2")
        self.assertEqual(calc.run("-7/3", 2, "DOWN"), "-2.3")

    def test_floor_goes_to_minus_infinity(self):
        self.assertEqual(calc.run("-2.5", 1, "FLOOR"), "-3")
        self.assertEqual(calc.run("-2.1", 1, "FLOOR"), "-3")
        self.assertEqual(calc.run("-7/3", 2, "FLOOR"), "-2.4")

    def test_positive_down_floor_agree(self):
        self.assertEqual(calc.run("2.9", 1, "DOWN"), "2")
        self.assertEqual(calc.run("2.9", 1, "FLOOR"), "2")

    def test_exact_negative_unchanged(self):
        self.assertEqual(calc.run("-2", 1, "FLOOR"), "-2")
        self.assertEqual(calc.run("-2", 1, "DOWN"), "-2")


class SqrtTest(unittest.TestCase):
    """(d) sqrt correctness."""

    SQRT2_50 = "1.4142135623730950488016887242096980785696718753769"

    def test_sqrt2_p50(self):
        self.assertEqual(calc.run("sqrt(2)", 50, "HALF_EVEN"), self.SQRT2_50)

    def test_sqrt2_prefix_various_precisions(self):
        digits = self.SQRT2_50.replace(".", "")
        for p in (1, 2, 5, 10, 20, 40):
            out = calc.run("sqrt(2)", p, "DOWN")
            self.assertEqual(out.replace(".", ""), digits[:p])

    def test_sqrt_perfect_squares_exact(self):
        self.assertEqual(calc.run("sqrt(4)", 3, "HALF_EVEN"), "2.00")
        self.assertEqual(calc.run("sqrt(1/9)", 4, "HALF_EVEN"), "0.3333")
        self.assertEqual(calc.run("sqrt(0)", 5, "HALF_EVEN"), "0")

    def test_sqrt_not_truncated(self):
        # sqrt(2) to 1 digit: 1.414... -> 1 (DOWN) but 1 (HALF_UP too);
        # use sqrt(3) = 1.732...: DOWN -> 1.7, HALF_UP -> 1.7, p=1 differs.
        self.assertEqual(calc.run("sqrt(3)", 1, "DOWN"), "1")
        self.assertEqual(calc.run("sqrt(3)", 1, "HALF_UP"), "2")
        self.assertEqual(calc.run("sqrt(3)", 2, "DOWN"), "1.7")
        self.assertEqual(calc.run("sqrt(3)", 2, "HALF_UP"), "1.7")

    def test_sqrt_negative_rejected(self):
        with self.assertRaises(calc.CalcError):
            calc.run("sqrt(-1)", 5, "HALF_EVEN")


class CliTest(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(ROOT / "calc.py"), *args],
            capture_output=True, text=True,
        )

    def test_basic(self):
        r = self.run_cli("1/3", "5", "HALF_UP")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "0.33333")

    def test_invalid_mode_exit2(self):
        r = self.run_cli("1/3", "5", "CEILING")
        self.assertEqual(r.returncode, 2)
        self.assertIn("invalid rounding mode", r.stderr)

    def test_nonpositive_precision_exit2(self):
        for p in ("0", "-3"):
            r = self.run_cli("1/3", p, "HALF_UP")
            self.assertEqual(r.returncode, 2, p)
            self.assertIn("precision", r.stderr)

    def test_noninteger_precision_exit2(self):
        r = self.run_cli("1/3", "x", "HALF_UP")
        self.assertEqual(r.returncode, 2)

    def test_division_by_zero_exit2(self):
        r = self.run_cli("1/0", "5", "HALF_UP")
        self.assertEqual(r.returncode, 2)

    def test_bad_expression_exit2(self):
        r = self.run_cli("1 +", "5", "HALF_UP")
        self.assertEqual(r.returncode, 2)

    def test_wrong_arity_exit2(self):
        r = self.run_cli("1/3", "5")
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
