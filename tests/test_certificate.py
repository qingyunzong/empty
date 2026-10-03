import copy
import json
import unittest
from fractions import Fraction

from algroots import (IsolationSession, Poly, build_certificate,
                      verify_certificate)


def make_cert(coeffs):
    session = IsolationSession(Poly(coeffs)).run()
    return build_certificate(session)


class TestCertificate(unittest.TestCase):
    def test_valid_certificate(self):
        # (x-1)^2 (x^2-2) (x+3): multiplicities 2 and 1, point and intervals
        p = (Poly([-1, 1]) ** 2) * Poly(["-2", "0", "1"]) * Poly([3, 1])
        cert = make_cert(p.to_json())
        ok, errors = verify_certificate(cert)
        self.assertTrue(ok, errors)

    def test_valid_certificate_constant_poly(self):
        cert = make_cert([5])
        ok, errors = verify_certificate(cert)
        self.assertTrue(ok, errors)

    def test_valid_certificate_json_roundtrip(self):
        p = Poly(["0", "-4", "0", 1]) * Poly(["-2", "0", "1"])
        cert = json.loads(json.dumps(make_cert(p.to_json())))
        ok, errors = verify_certificate(cert)
        self.assertTrue(ok, errors)

    def test_tampered_variation_count(self):
        cert = make_cert(["-2", "0", "1"])
        cert["factors"][0]["variations"]["at_lower_bound"] += 1
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_interval_endpoint(self):
        cert = make_cert(["-2", "0", "1"])
        root = next(r for f in cert["factors"] for r in f["roots"]
                    if r["type"] == "interval")
        # move the interval somewhere with no root inside (bound is 3)
        root["lower"] = "2"
        root["upper"] = "5/2"
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_missing_root(self):
        cert = make_cert(["-2", "0", "1"])
        cert["factors"][0]["roots"] = cert["factors"][0]["roots"][:1]
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_multiplicity(self):
        p = (Poly([-1, 1]) ** 2) * Poly([3, 1])
        cert = make_cert(p.to_json())
        cert["factors"][0]["multiplicity"] += 1
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_sturm_chain(self):
        cert = make_cert(["-2", "0", "1"])
        chain = cert["factors"][0]["sturm"]
        chain[-1] = ["7"]  # wrong constant tail
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_point_root(self):
        cert = make_cert(["0", "-4", "0", "1"])  # roots -2, 0, 2
        point = next(r for f in cert["factors"] for r in f["roots"]
                     if r["type"] == "point")
        point["value"] = "1/2"
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_factor_relation(self):
        p = (Poly([-1, 1]) ** 2) * Poly([3, 1])
        cert = make_cert(p.to_json())
        cert["content"] = "2"
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
