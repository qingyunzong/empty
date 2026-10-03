import copy
import unittest

from symdfa import MAX_CHAR, Machine, check, verify_counterexample, verify_proof


def pair():
    a = Machine.create(
        ["q0", "q1"], "q0", ["q1"],
        {"q0": [[0, 10, "q1"], [20, 30, "q1"]], "q1": [[0, MAX_CHAR, "q1"]]})
    b = Machine.create(
        ["r0", "r1"], "r0", ["r1"],
        {"r0": [[0, 10, "r1"], [20, 30, "r1"]], "r1": [[0, MAX_CHAR, "r1"]]})
    return a, b


class TestVerifyProof(unittest.TestCase):
    def setUp(self):
        self.a, self.b = pair()
        self.proof = check(self.a, self.b).proof

    def tampered(self, fn):
        proof = copy.deepcopy(self.proof)
        fn(proof)
        return verify_proof(self.a, self.b, proof)

    def test_valid_proof_accepted(self):
        self.assertEqual(verify_proof(self.a, self.b, self.proof), [])

    def test_tampered_version_binding(self):
        errors = self.tampered(lambda p: p.__setitem__("version_a", 99))
        self.assertTrue(any("version" in e for e in errors))

    def test_tampered_removed_entry(self):
        errors = self.tampered(lambda p: p["entries"].pop())
        self.assertTrue(errors)

    def test_tampered_coverage_gap(self):
        def fn(p):
            p["entries"][0]["edges"][0]["lo"] = 1
        errors = self.tampered(fn)
        self.assertTrue(any("gap or overlap" in e for e in errors))

    def test_tampered_truncated_coverage(self):
        def fn(p):
            p["entries"][0]["edges"][-1]["hi"] = MAX_CHAR - 1
        errors = self.tampered(fn)
        self.assertTrue(any("do not cover" in e for e in errors))

    def test_tampered_edge_target(self):
        def fn(p):
            p["entries"][0]["edges"][0]["next"] = ["q0", "r1"]
        errors = self.tampered(fn)
        self.assertTrue(errors)

    def test_tampered_successor_not_covered(self):
        def fn(p):
            p["entries"][0]["edges"][0]["next"] = ["q1", None]
        errors = self.tampered(fn)
        self.assertTrue(any("not covered" in e for e in errors))

    def test_tampered_acceptance_mismatch(self):
        def fn(p):
            p["entries"].append({"pair": ["q1", None], "edges": [
                {"lo": 0, "hi": MAX_CHAR, "next": ["q1", None]}]})
        errors = self.tampered(fn)
        self.assertTrue(any("acceptance mismatch" in e for e in errors))

    def test_tampered_unknown_state(self):
        def fn(p):
            p["entries"][0]["pair"] = ["ghost", "r0"]
        errors = self.tampered(fn)
        self.assertTrue(errors)


class TestVerifyCounterexample(unittest.TestCase):
    def setUp(self):
        self.a = Machine.create(["q0", "q1"], "q0", ["q1"],
                                {"q0": [[3, 3, "q1"]]})
        self.b = Machine.create(["r0"], "r0", [], {})
        self.cert = check(self.a, self.b).counterexample

    def test_valid_certificate_accepted(self):
        self.assertEqual(self.cert["word"], [3])
        self.assertEqual(verify_counterexample(self.a, self.b, self.cert), [])

    def test_tampered_word(self):
        cert = dict(self.cert, word=[4])
        self.assertTrue(verify_counterexample(self.a, self.b, cert))

    def test_tampered_claimed_acceptance(self):
        cert = dict(self.cert, accepts_a=False)
        self.assertTrue(verify_counterexample(self.a, self.b, cert))

    def test_out_of_range_word(self):
        cert = dict(self.cert, word=[MAX_CHAR + 1])
        self.assertTrue(verify_counterexample(self.a, self.b, cert))


if __name__ == "__main__":
    unittest.main()
