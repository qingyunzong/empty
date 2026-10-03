import copy
import unittest
from fractions import Fraction

from ridag.dag import DAG
from ridag.interval import End, Interval, IntervalUnion
from ridag.newton import Isolator, UNIQUE
from ridag.cert import verify_certificate
from ridag.jsonio import cert_to_json, interval_to_json


def make_cert():
    dag = DAG()
    x = dag.var("x")
    f = dag.mul(dag.sub(x, dag.const(Fraction(1, 3))),
                dag.sub(x, 2))
    dom = IntervalUnion([Interval.closed(End(-10), End(10))])
    cert = Isolator(dag, f, "x", dom, eps=Fraction(1, 10 ** 12)).isolate()
    return cert_to_json(cert)


class TestCertificateChecker(unittest.TestCase):
    def test_valid_certificate_passes(self):
        ok, errors = verify_certificate(make_cert())
        self.assertTrue(ok, errors)

    def test_tampered_claim_interval_rejected(self):
        cert = make_cert()
        # widen a unique_root claim: inclusion/uniqueness must break
        for c in cert["claims"]:
            if c["status"] == "unique_root" and not c["interval"]["lo_open"]:
                c["interval"]["lo"] = "-1000"
                break
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)
        self.assertTrue(errors)

    def test_forged_no_root_over_root_rejected(self):
        cert = make_cert()
        # flip a unique_root claim into no_root with exclude evidence:
        # the recomputed enclosure contains 0, so the forgery must fail
        for c in cert["claims"]:
            if c["status"] == "unique_root":
                c["status"] = "no_root"
                c["evidence"] = {"kind": "exclude"}
                break
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_dropped_claim_breaks_coverage(self):
        cert = make_cert()
        # removing a unique_root claim must break domain coverage
        cert["claims"] = [c for c in cert["claims"]
                          if c["status"] != "unique_root"]
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_forged_step_inclusion_rejected(self):
        cert = make_cert()
        # corrupt a newton/exclude step output so it escapes its box
        for s in cert["steps"]:
            if s["out"]:
                s["out"][0] = interval_to_json(
                    Interval.closed(End(-99999), End(99999)))
                break
        ok, errors = verify_certificate(cert)
        self.assertFalse(ok)

    def test_undecided_claims_accepted(self):
        dag = DAG()
        x = dag.var("x")
        f = dag.sub(dag.pow(x, 2), dag.const(2))
        dom = IntervalUnion([Interval.closed(End(-10), End(10))])
        cert = Isolator(dag, f, "x", dom, budget=2,
                        eps=Fraction(1, 10 ** 12)).isolate()
        ok, errors = verify_certificate(cert_to_json(cert))
        self.assertTrue(ok, errors)


if __name__ == "__main__":
    unittest.main()
