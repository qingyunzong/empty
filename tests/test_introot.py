import unittest

from exactnum import (
    IntRootEvidence,
    capped_pow_leq,
    integer_kth_root,
    verify_introot_evidence,
)


class TestCappedPow(unittest.TestCase):
    def test_boundary_values(self):
        self.assertTrue(capped_pow_leq(10, 3, 1000))
        self.assertFalse(capped_pow_leq(10, 3, 999))
        self.assertTrue(capped_pow_leq(0, 5, 0))
        self.assertTrue(capped_pow_leq(1, 100, 1))
        self.assertTrue(capped_pow_leq(7, 0, 1))

    def test_truncation_avoids_huge_power(self):
        # 10**10 ** 10 = 10**100 would be a large intermediate; the capped
        # comparison must answer immediately against a tiny bound.
        self.assertFalse(capped_pow_leq(10**10, 10, 5))
        self.assertTrue(capped_pow_leq(10**10, 10, 10**100))

    def test_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            capped_pow_leq(-2, 3, 5)
        with self.assertRaises(ValueError):
            capped_pow_leq(2, -1, 5)


class TestIntegerKthRoot(unittest.TestCase):
    def test_small_exhaustive(self):
        for k in range(1, 6):
            for n in range(0, 400):
                ev = integer_kth_root(n, k)
                self.assertTrue(verify_introot_evidence(ev))
                self.assertLessEqual(ev.r**k, n)
                self.assertLess(n, (ev.r + 1) ** k)

    def test_huge_boundary_inputs(self):
        # Inputs constructed by integer powers to sit exactly on, just
        # below, and just above a k-th power boundary.
        for base, k in ((10**30, 7), (2**64, 5), (123456789123456789, 3)):
            n_exact = base**k
            for n, expected in (
                (n_exact - 1, base - 1),
                (n_exact, base),
                (n_exact + 1, base),
            ):
                ev = integer_kth_root(n, k)
                self.assertEqual(ev.r, expected)
                self.assertEqual(ev.r_pow_k, expected**k)
                self.assertEqual(ev.r_plus_1_pow_k, (expected + 1) ** k)
                self.assertTrue(verify_introot_evidence(ev))

    def test_negative_odd_root(self):
        cases = [(-8, 3, -2), (-9, 3, -3), (-7, 3, -2), (-1, 3, -1),
                 (-32, 5, -2), (-33, 5, -3)]
        for n, k, expected in cases:
            ev = integer_kth_root(n, k)
            self.assertEqual(ev.r, expected)
            self.assertTrue(verify_introot_evidence(ev))
            self.assertLessEqual(ev.r**k, n)
            self.assertLess(n, (ev.r + 1) ** k)

    def test_negative_huge_boundary(self):
        base = 10**25
        n = -(base**3)
        self.assertEqual(integer_kth_root(n, 3).r, -base)
        self.assertEqual(integer_kth_root(n - 1, 3).r, -(base + 1))
        self.assertEqual(integer_kth_root(n + 1, 3).r, -base)

    def test_invalid_inputs(self):
        with self.assertRaises(ValueError):
            integer_kth_root(10, 0)
        with self.assertRaises(ValueError):
            integer_kth_root(-16, 2)
        with self.assertRaises(ValueError):
            integer_kth_root(-16, 4)
        with self.assertRaises(TypeError):
            integer_kth_root("10", 2)

    def test_tampered_evidence_rejected(self):
        good = integer_kth_root(10**60, 4)
        self.assertTrue(verify_introot_evidence(good))
        # Shifted root.
        bad_r = IntRootEvidence(good.n, good.k, good.r + 1,
                                (good.r + 1) ** 4, (good.r + 2) ** 4)
        self.assertFalse(verify_introot_evidence(bad_r))
        # Falsified lower power.
        bad_low = IntRootEvidence(good.n, good.k, good.r,
                                  good.r_pow_k - 1, good.r_plus_1_pow_k)
        self.assertFalse(verify_introot_evidence(bad_low))
        # Falsified upper power.
        bad_up = IntRootEvidence(good.n, good.k, good.r,
                                 good.r_pow_k, good.r_plus_1_pow_k - 1)
        self.assertFalse(verify_introot_evidence(bad_up))
        # Falsified n: below the lower power and at the upper power.
        bad_n_low = IntRootEvidence(good.r_pow_k - 1, good.k, good.r,
                                    good.r_pow_k, good.r_plus_1_pow_k)
        self.assertFalse(verify_introot_evidence(bad_n_low))
        bad_n_high = IntRootEvidence(good.r_plus_1_pow_k, good.k, good.r,
                                     good.r_pow_k, good.r_plus_1_pow_k)
        self.assertFalse(verify_introot_evidence(bad_n_high))
        # Even root of a negative number can never be valid evidence.
        bad_neg = IntRootEvidence(-16, 2, 3, 9, 16)
        self.assertFalse(verify_introot_evidence(bad_neg))
        # Non-integer fields.
        bad_type = IntRootEvidence(10, 2, 3, 9, 16)
        object.__setattr__(bad_type, "r_pow_k", "9")
        self.assertFalse(verify_introot_evidence(bad_type))

    def test_evidence_roundtrip_dict(self):
        ev = integer_kth_root(987654321**5, 5)
        ev2 = IntRootEvidence.from_dict(ev.to_dict())
        self.assertEqual(ev, ev2)
        self.assertTrue(verify_introot_evidence(ev2))


if __name__ == "__main__":
    unittest.main()
