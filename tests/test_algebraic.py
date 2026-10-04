import math
import os
import tempfile
import unittest
from fractions import Fraction

from exactnum import (
    AlgebraicNumber,
    EvidenceCache,
    EvidenceError,
    RefinementBudgetExhausted,
)


def sqrt2(**kw):
    return AlgebraicNumber([-2, 0, 1], 1, 2, **kw)


def sqrt3(**kw):
    return AlgebraicNumber([-3, 0, 1], 1, 2, **kw)


def reference_round_half_even(x):
    """Independent round-half-to-even over Fractions."""
    m = math.floor(x)
    diff = x - m
    if diff < Fraction(1, 2):
        return m
    if diff > Fraction(1, 2):
        return m + 1
    return m if m % 2 == 0 else m + 1


class TestRounding(unittest.TestCase):
    def test_sqrt2(self):
        a = sqrt2()
        self.assertEqual(a.floor(), 1)
        self.assertEqual(a.ceil(), 2)
        self.assertEqual(a.round_half_even(), 1)

    def test_sqrt3_round(self):
        self.assertEqual(sqrt3().round_half_even(), 2)

    def test_negative_irrational(self):
        a = AlgebraicNumber([-2, 0, 1], -2, -1)  # -sqrt(2)
        self.assertEqual(a.floor(), -2)
        self.assertEqual(a.ceil(), -1)
        self.assertEqual(a.round_half_even(), -1)

    def test_round_ties_to_even(self):
        ties = [
            (Fraction(1, 2), 0), (Fraction(3, 2), 2), (Fraction(5, 2), 2),
            (Fraction(7, 2), 4), (Fraction(9, 2), 4),
            (Fraction(-1, 2), 0), (Fraction(-3, 2), -2),
            (Fraction(-5, 2), -2), (Fraction(-7, 2), -4),
        ]
        for value, expected in ties:
            alg = AlgebraicNumber.from_rational(value)
            self.assertEqual(alg.round_half_even(), expected, value)

    def test_negative_half_integer_via_polynomial(self):
        # 2x + 5 = 0 -> x = -5/2, a negative half-integer tie.
        alg = AlgebraicNumber([5, 2], -3, -2)
        self.assertEqual(alg.round_half_even(), -2)
        self.assertEqual(alg.floor(), -3)
        self.assertEqual(alg.ceil(), -2)

    def test_exact_rational_root_hit_by_bisection(self):
        # (x - 3)^3 = x^3 - 9x^2 + 27x - 27; bisection of (2, 4) lands on 3.
        alg = AlgebraicNumber([-27, 27, -9, 1], 2, 4)
        self.assertEqual(alg.floor(), 3)
        self.assertEqual(alg.ceil(), 3)
        self.assertTrue(alg.is_exact_rational)

    def test_decimal_inputs_cross_checked(self):
        # Exhaustive decimal sweep: every result is compared against an
        # independent pure-Fraction reference computation.
        for cents in range(-500, 501):
            x = Fraction(cents, 100)
            alg = AlgebraicNumber.from_decimal(f"{cents / 100:.2f}")
            self.assertEqual(alg.interval[0], x)
            self.assertEqual(alg.floor(), math.floor(x), x)
            self.assertEqual(alg.ceil(), math.ceil(x), x)
            self.assertEqual(alg.round_half_even(),
                             reference_round_half_even(x), x)

    def test_kth_root_constructor(self):
        self.assertEqual(AlgebraicNumber.kth_root(27, 3).floor(), 3)
        self.assertTrue(AlgebraicNumber.kth_root(27, 3).is_exact_rational)
        self.assertEqual(AlgebraicNumber.kth_root(28, 3).floor(), 3)
        self.assertEqual(AlgebraicNumber.kth_root(28, 3).ceil(), 4)
        # Negative odd roots.
        neg = AlgebraicNumber.kth_root(-9, 3)
        self.assertEqual(neg.floor(), -3)
        self.assertEqual(neg.ceil(), -2)
        self.assertEqual(AlgebraicNumber.kth_root(-8, 3).floor(), -2)
        with self.assertRaises(ValueError):
            AlgebraicNumber.kth_root(-16, 2)


class TestScaling(unittest.TestCase):
    def test_scaled_rounding_exactly_verified(self):
        # (3/7) * sqrt(2): verify each rounding result with pure integer
        # comparisons against 2 = sqrt(2)^2.
        scaled = sqrt2().scale(Fraction(3, 7))
        m = scaled.floor()
        self.assertEqual(m, 0)
        self.assertLessEqual((7 * m) ** 2, 2 * 9)
        self.assertLess(2 * 9, (7 * (m + 1)) ** 2)
        self.assertEqual(scaled.ceil(), 1)
        self.assertEqual(scaled.round_half_even(), 1)
        # Boundary of the half-integer decision: (3/7)*sqrt(2) vs 1/2
        # decided exactly since 2*9 > 7**2/4 ... check via squares.
        self.assertGreater(2 * 36, 49)  # (6/7)^2 *2 ... sanity of direction

    def test_negative_scale(self):
        scaled = sqrt2().scale(Fraction(-3, 7))
        self.assertEqual(scaled.floor(), -1)
        self.assertEqual(scaled.ceil(), 0)
        self.assertEqual(scaled.round_half_even(), -1)

    def test_zero_scale(self):
        z = sqrt2().scale(Fraction(0))
        self.assertEqual(z.floor(), 0)
        self.assertEqual(z.round_half_even(), 0)

    def test_scale_of_rational_tie(self):
        # (1/2) * 5 = 5/2 -> tie to even 2; (1/2) * 7 = 7/2 -> 4.
        five = AlgebraicNumber.from_rational(5)
        seven = AlgebraicNumber.from_rational(7)
        self.assertEqual(five.scale(Fraction(1, 2)).round_half_even(), 2)
        self.assertEqual(seven.scale(Fraction(1, 2)).round_half_even(), 4)

    def test_scaled_compare(self):
        a = sqrt2().scale(Fraction(3, 7))
        b = sqrt2().scale(Fraction(2, 7))
        self.assertEqual(a.compare(b), 1)
        self.assertEqual(b.compare(a), -1)


class TestCompare(unittest.TestCase):
    def test_distinct_roots(self):
        self.assertEqual(sqrt2().compare(sqrt3()), -1)
        self.assertEqual(sqrt3().compare(sqrt2()), 1)
        self.assertLess(sqrt2(), sqrt3())

    def test_same_number_different_representations(self):
        reps = [
            AlgebraicNumber([-2, 0, 1], 1, 2),                 # x^2 - 2
            AlgebraicNumber([-4, 0, 2], 1, 2),                 # 2x^2 - 4
            AlgebraicNumber([4, 0, -4, 0, 1], 1, 2),           # (x^2-2)^2
            AlgebraicNumber([0, -2, 0, 1], 1, 2),              # x^3 - 2x
            AlgebraicNumber([-4, 0, 0, 0, 1], 1, 2),           # x^4 - 4
        ]
        for i in range(len(reps)):
            for j in range(len(reps)):
                self.assertEqual(reps[i].compare(reps[j]), 0, (i, j))
                if i != j:
                    self.assertEqual(reps[i], reps[j])

    def test_multiple_root_polynomial(self):
        # (x^2 - 2)^2 has sqrt(2) as a double root; square-free reduction
        # must still isolate and compare it exactly.
        squared = AlgebraicNumber([4, 0, -4, 0, 1], 1, 2)
        self.assertEqual(squared.floor(), 1)
        self.assertEqual(squared.compare(sqrt2()), 0)
        self.assertEqual(squared, sqrt2())

    def test_compare_with_rational(self):
        a = sqrt2()
        self.assertEqual(a.compare_rational(Fraction(3, 2)), -1)
        self.assertEqual(a.compare_rational(Fraction(1)), 1)
        self.assertEqual(a.compare(Fraction(7, 5)), 1)
        exact = AlgebraicNumber.from_rational(Fraction(3, 2))
        self.assertEqual(exact.compare(Fraction(3, 2)), 0)

    def test_compare_rational_point_against_algebraic(self):
        half = AlgebraicNumber.from_rational(Fraction(3, 2))
        self.assertEqual(half.compare(sqrt2()), 1)


class TestBudget(unittest.TestCase):
    def test_budget_zero_raises_when_refinement_needed(self):
        alg = AlgebraicNumber([-2, 0, 1], 1, 3)  # straddles integer 2
        with self.assertRaises(RefinementBudgetExhausted):
            alg.floor(0)

    def test_budget_zero_succeeds_without_refinement(self):
        alg = AlgebraicNumber([-2, 0, 1], 1, 2)
        self.assertEqual(alg.floor(0), 1)
        self.assertEqual(alg.ceil(0), 2)

    def test_budget_zero_compare(self):
        a = AlgebraicNumber([-2, 0, 1], 1, 2)
        b = AlgebraicNumber([-3, 0, 1], 1, 2)
        with self.assertRaises(RefinementBudgetExhausted):
            a.compare(b, 0)
        tight_a = AlgebraicNumber([-2, 0, 1], 1, Fraction(3, 2))
        tight_b = AlgebraicNumber([-3, 0, 1], Fraction(3, 2), 2)
        self.assertEqual(tight_a.compare(tight_b, 0), -1)

    def test_budget_zero_round_tie_is_exact(self):
        # Exact rational tie needs no refinement at all.
        alg = AlgebraicNumber.from_rational(Fraction(5, 2))
        self.assertEqual(alg.round_half_even(0), 2)

    def test_budget_counts_refinements(self):
        alg = AlgebraicNumber([-2, 0, 1], 1, 3)
        with self.assertRaises(RefinementBudgetExhausted):
            alg.floor(0)
        self.assertEqual(AlgebraicNumber([-2, 0, 1], 1, 3).floor(1), 1)


class TestCacheCheckpoint(unittest.TestCase):
    def test_checkpoint_resume(self):
        cache = EvidenceCache()
        alg = AlgebraicNumber([-2, 0, 1], 1, 3, cache=cache)
        self.assertEqual(alg.floor(), 1)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "checkpoint.json")
            cache.save(path)
            restored = EvidenceCache.load(path)
        # After recovery the refined interval is adopted, so even a zero
        # budget suffices to decide.
        resumed = AlgebraicNumber([-2, 0, 1], 1, 3, cache=restored)
        self.assertEqual(resumed.floor(0), 1)

    def test_cache_shared_across_equivalent_polynomials(self):
        cache = EvidenceCache()
        AlgebraicNumber([-2, 0, 1], 1, 3, cache=cache).floor()
        # (x^2-2)^2 reduces to the same square-free polynomial, so the
        # cached refinement applies and no further refinement is needed.
        other = AlgebraicNumber([4, 0, -4, 0, 1], 1, 3, cache=cache)
        self.assertEqual(other.floor(0), 1)

    def test_tampered_checkpoint_rejected(self):
        cache = EvidenceCache()
        AlgebraicNumber([-2, 0, 1], 1, 3, cache=cache).floor()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "checkpoint.json")
            cache.save(path)
            with open(path, "r", encoding="utf-8") as fh:
                data = fh.read()

            # Tamper 1: interval with no sign change (both endpoints > root).
            import json
            good = json.loads(data)
            key = next(iter(good["intervals"]))
            bad1 = json.loads(data)
            bad1["intervals"][key] = ["3/2", "2"]
            p1 = os.path.join(tmp, "bad1.json")
            with open(p1, "w", encoding="utf-8") as fh:
                json.dump(bad1, fh)
            with self.assertRaises(EvidenceError):
                EvidenceCache.load(p1)

            # Tamper 2: refined interval escapes the isolating interval.
            bad2 = json.loads(data)
            bad2["intervals"][key] = ["1", "4"]
            p2 = os.path.join(tmp, "bad2.json")
            with open(p2, "w", encoding="utf-8") as fh:
                json.dump(bad2, fh)
            with self.assertRaises(EvidenceError):
                EvidenceCache.load(p2)

            # Tamper 3: inverted endpoints.
            bad3 = json.loads(data)
            bad3["intervals"][key] = ["2", "1"]
            p3 = os.path.join(tmp, "bad3.json")
            with open(p3, "w", encoding="utf-8") as fh:
                json.dump(bad3, fh)
            with self.assertRaises(EvidenceError):
                EvidenceCache.load(p3)

            # Tamper 4: corrupt structure.
            p4 = os.path.join(tmp, "bad4.json")
            with open(p4, "w", encoding="utf-8") as fh:
                json.dump({"version": 1, "intervals": {key: "junk"}}, fh)
            with self.assertRaises(EvidenceError):
                EvidenceCache.load(p4)

    def test_untampered_checkpoint_accepted(self):
        cache = EvidenceCache()
        AlgebraicNumber([-3, 0, 1], 1, 2, cache=cache).floor()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "ok.json")
            cache.save(path)
            restored = EvidenceCache.load(path)
        self.assertEqual(restored.intervals, cache.intervals)


class TestConstructionValidation(unittest.TestCase):
    def test_non_isolating_interval_rejected(self):
        with self.assertRaises(ValueError):
            AlgebraicNumber([-2, 0, 1], 2, 3)  # no sign change
        with self.assertRaises(ValueError):
            # x^3 - 2x has three roots in (-2, 2): Sturm count rejects it.
            AlgebraicNumber([0, -2, 0, 1], -2, 2)
        with self.assertRaises(ValueError):
            AlgebraicNumber([-2, 0, 1], 3, 1)  # empty interval
        with self.assertRaises(ValueError):
            AlgebraicNumber([1, 1], 0, 0)  # point that is not a root

    def test_endpoint_root_becomes_exact(self):
        alg = AlgebraicNumber([-4, 0, 1], 2, 5)  # x^2 - 4, root at 2
        self.assertTrue(alg.is_exact_rational)
        self.assertEqual(alg.floor(), 2)


if __name__ == "__main__":
    unittest.main()
