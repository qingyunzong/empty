import unittest

from exactcalc.introot import (
    int_kth_root_floor,
    pow_cap,
    root_evidence,
    verify_root_evidence,
)


class TestPowCap(unittest.TestCase):
    def test_matches_exact_within_cap(self):
        for base in range(-6, 7):
            for exp in range(0, 7):
                for cap in (0, 1, 5, 30, 1000):
                    got = pow_cap(base, exp, cap)
                    exact = base ** exp
                    if exact > cap:
                        self.assertEqual(got, cap + 1)
                    elif exact < -(cap + 1):
                        self.assertEqual(got, -(cap + 1))
                    else:
                        self.assertEqual(got, exact)

    def test_saturation_avoids_huge_intermediates(self):
        # The true value has 10**6 digits; the capped value must not.
        got = pow_cap(10 ** 100, 10 ** 4, 10 ** 6)
        self.assertEqual(got, 10 ** 6 + 1)

    def test_negative_saturation(self):
        self.assertEqual(pow_cap(-(10 ** 50), 3, 10 ** 6), -(10 ** 6 + 1))
        self.assertEqual(pow_cap(-(10 ** 50), 2, 10 ** 6), 10 ** 6 + 1)

    def test_rejects_bad_arguments(self):
        with self.assertRaises(ValueError):
            pow_cap(2, -1, 10)
        with self.assertRaises(ValueError):
            pow_cap(2, 3, -1)


class TestIntKthRootFloor(unittest.TestCase):
    def test_small_exhaustive(self):
        for k in range(1, 7):
            for n in range(0, 300):
                r = int_kth_root_floor(n, k)
                self.assertLessEqual(r ** k, n)
                self.assertLess(n, (r + 1) ** k)

    def test_huge_boundaries(self):
        # Constructed exactly at/around integer powers: no float could
        # decide these boundaries.
        for m, k in ((10 ** 25 + 3, 2), (10 ** 18 + 1, 3),
                     (10 ** 9 + 7, 7), (10 ** 4 + 1, 13)):
            base = m ** k
            self.assertEqual(int_kth_root_floor(base, k), m)
            self.assertEqual(int_kth_root_floor(base - 1, k), m - 1)
            self.assertEqual(int_kth_root_floor(base + 1, k), m)
            top = (m + 1) ** k
            self.assertEqual(int_kth_root_floor(top - 1, k), m)
            self.assertEqual(int_kth_root_floor(top, k), m + 1)

    def test_negative_odd_root_definition(self):
        self.assertEqual(int_kth_root_floor(-9, 3), -3)   # -27 <= -9 < -8
        self.assertEqual(int_kth_root_floor(-8, 3), -2)   # exact cube
        self.assertEqual(int_kth_root_floor(-7, 3), -2)
        self.assertEqual(int_kth_root_floor(-1, 5), -1)
        m = 10 ** 12 + 5
        cube = m ** 3
        self.assertEqual(int_kth_root_floor(-cube, 3), -m)
        self.assertEqual(int_kth_root_floor(-cube - 1, 3), -m - 1)
        self.assertEqual(int_kth_root_floor(-cube + 1, 3), -m)

    def test_negative_odd_root_exhaustive(self):
        for k in (1, 3, 5):
            for n in range(-200, 0):
                r = int_kth_root_floor(n, k)
                self.assertLessEqual(r ** k, n)
                self.assertLess(n, (r + 1) ** k)

    def test_even_root_of_negative_rejected(self):
        for k in (2, 4, 10):
            with self.assertRaises(ValueError):
                int_kth_root_floor(-16, k)

    def test_bad_k_rejected(self):
        with self.assertRaises(ValueError):
            int_kth_root_floor(10, 0)
        with self.assertRaises(ValueError):
            int_kth_root_floor(10, -3)


class TestRootEvidence(unittest.TestCase):
    def test_evidence_roundtrip(self):
        for n, k in ((1000, 3), (10 ** 40, 7), (-(10 ** 30), 3), (0, 2), (5, 1)):
            ev = root_evidence(n, k)
            self.assertTrue(verify_root_evidence(ev))
            self.assertEqual(ev["r"], int_kth_root_floor(n, k))

    def test_tampered_evidence_rejected(self):
        ev = root_evidence(1000, 3)  # r == 10
        self.assertFalse(verify_root_evidence({**ev, "r": 9}))
        self.assertFalse(verify_root_evidence({**ev, "r": 11}))
        self.assertFalse(verify_root_evidence({**ev, "n": 999}))
        self.assertFalse(verify_root_evidence({**ev, "n": 1331}))
        self.assertFalse(verify_root_evidence({**ev, "k": 4}))
        self.assertFalse(verify_root_evidence({"n": 1000, "k": 3}))
        self.assertFalse(verify_root_evidence({"n": "1000", "k": 3, "r": 10}))
        self.assertFalse(verify_root_evidence({"n": 1000, "k": 3, "r": True}))
        self.assertFalse(verify_root_evidence(None))
        self.assertFalse(verify_root_evidence({"n": -16, "k": 2, "r": 0}))

    def test_huge_tampered_boundary_rejected(self):
        m = 10 ** 30 + 1
        n = m ** 7
        good = root_evidence(n, 7)
        self.assertTrue(verify_root_evidence(good))
        # Off-by-one at the boundary must fail verification.
        self.assertFalse(verify_root_evidence({"n": n, "k": 7, "r": m - 1}))
        self.assertFalse(verify_root_evidence({"n": n, "k": 7, "r": m + 1}))
        self.assertFalse(verify_root_evidence({"n": n - 1, "k": 7, "r": m}))


if __name__ == "__main__":
    unittest.main()
