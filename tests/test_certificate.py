import copy
import unittest
from fractions import Fraction

from realroots.certificate import build_certificate
from realroots.verify import verify_certificate

from helpers import linear, poly_from_roots, poly_pow
from realroots import poly as P


def mixed_poly():
    # (x^2-2) * (x-1)^2 * (x+3): irrational roots + multiple rational root
    f = P.mul((Fraction(-2), Fraction(0), Fraction(1)), poly_pow(linear(1), 2))
    return P.mul(f, linear(-3))


class TestCertificateValid(unittest.TestCase):
    def test_valid_certificate(self):
        cert, roots = build_certificate(mixed_poly(), eps=Fraction(1, 16))
        ok, checks = verify_certificate(cert)
        self.assertTrue(ok, [c for c in checks if not c["ok"]])
        self.assertEqual(len(roots), 4)  # -3, -sqrt2, 1, sqrt2

    def test_certificate_records_multiplicity(self):
        cert, _ = build_certificate(mixed_poly())
        mults = sorted(r["multiplicity"] for r in cert["roots"])
        self.assertEqual(mults, [1, 1, 1, 2])

    def test_constant_polynomial_certificate(self):
        cert, roots = build_certificate([7])
        self.assertEqual(roots, [])
        ok, _ = verify_certificate(cert)
        self.assertTrue(ok)

    def test_point_roots_certificate(self):
        cert, roots = build_certificate([3, -4, 1], eps=Fraction(1))
        self.assertEqual([r["kind"] for r in roots], ["point", "point"])
        ok, checks = verify_certificate(cert)
        self.assertTrue(ok, [c for c in checks if not c["ok"]])


class TestCertificateTampering(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cert, _ = build_certificate(mixed_poly(), eps=Fraction(1, 16))

    def assert_invalid(self, cert):
        ok, checks = verify_certificate(cert)
        self.assertFalse(ok)
        self.assertTrue(any(not c["ok"] for c in checks))

    def test_tampered_interval_bound(self):
        cert = copy.deepcopy(self.cert)
        r = next(x for x in cert["roots"] if x["kind"] == "interval")
        r["lo"] = "1/3"  # not a valid bisection endpoint count
        self.assert_invalid(cert)

    def test_tampered_sturm_sequence(self):
        cert = copy.deepcopy(self.cert)
        cert["squarefree_factors"][0]["sturm"][1] = [1, 1]
        self.assert_invalid(cert)

    def test_removed_root_breaks_coverage(self):
        cert = copy.deepcopy(self.cert)
        cert["roots"] = cert["roots"][1:]
        self.assert_invalid(cert)

    def test_tampered_multiplicity(self):
        cert = copy.deepcopy(self.cert)
        cert["roots"][0]["multiplicity"] += 1
        self.assert_invalid(cert)

    def test_tampered_factor(self):
        cert = copy.deepcopy(self.cert)
        cert["squarefree_factors"][0]["factor"][0] = 999
        self.assert_invalid(cert)

    def test_tampered_variation_count(self):
        cert = copy.deepcopy(self.cert)
        r = next(x for x in cert["roots"] if x["kind"] == "interval")
        r["sign_variations_lo"] += 1
        self.assert_invalid(cert)

    def test_swapped_intervals_break_separation(self):
        cert = copy.deepcopy(self.cert)
        cert["roots"][0], cert["roots"][1] = cert["roots"][1], cert["roots"][0]
        self.assert_invalid(cert)


if __name__ == "__main__":
    unittest.main()
