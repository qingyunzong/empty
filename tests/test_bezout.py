import unittest
from fractions import Fraction

from polygcd import bezout_certificate, euclid_gcd_qq, gcd_modular, verify_bezout
from polygcd import poly
from polygcd.bezout import cert_from_json, cert_to_json


def make_pair():
    d = [3, -1, 2]
    a = [1, 1, 1]
    b = [2, -3]
    return poly.mul(d, a), poly.mul(d, b), d


class TestBezout(unittest.TestCase):
    def test_certificate_identity_holds(self):
        f, g, d = make_pair()
        cert = bezout_certificate(f, g, d)
        self.assertTrue(verify_bezout(f, g, cert))
        lhs = poly.add(poly.mul(cert["s"], poly.to_qq(f)),
                       poly.mul(cert["t"], poly.to_qq(g)))
        self.assertTrue(poly.eq(lhs, poly.to_qq(d)))

    def test_certificate_matches_modular_gcd(self):
        f, g, _ = make_pair()
        got = gcd_modular(f, g)
        cert = bezout_certificate(f, g, got.gcd)
        self.assertTrue(verify_bezout(f, g, cert))

    def test_forged_remainder_certificate_rejected(self):
        f, g, d = make_pair()
        cert = bezout_certificate(f, g, d)
        # tamper with s: identity must fail
        forged = dict(cert)
        forged["s"] = poly.trim(cert["s"] + [Fraction(1, 3)])
        self.assertFalse(verify_bezout(f, g, forged))
        # tamper with t
        forged = dict(cert)
        t = list(cert["t"])
        t[0] += Fraction(1)
        forged["t"] = t
        self.assertFalse(verify_bezout(f, g, forged))
        # tamper with d (not a divisor)
        forged = dict(cert)
        forged["d"] = poly.trim(list(cert["d"]) + [Fraction(1)])
        self.assertFalse(verify_bezout(f, g, forged))
        # non-primitive d
        forged = dict(cert)
        forged["d"] = [2 * c for c in cert["d"]]
        self.assertFalse(verify_bezout(f, g, forged))
        # wrong key / malformed
        self.assertFalse(verify_bezout(f, g, {"s": [], "t": []}))

    def test_json_roundtrip(self):
        f, g, d = make_pair()
        cert = bezout_certificate(f, g, d)
        restored = cert_from_json(cert_to_json(cert))
        self.assertTrue(verify_bezout(f, g, restored))

    def test_equal_inputs(self):
        f = [6, -9, 3]
        d = euclid_gcd_qq(f, f)
        cert = bezout_certificate(f, f, d)
        self.assertTrue(verify_bezout(f, f, cert))


if __name__ == "__main__":
    unittest.main()
