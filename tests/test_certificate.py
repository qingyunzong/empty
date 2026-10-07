import copy
import unittest

from patchtool import FileTree, diff_trees, op_key
from patchtool.certificate import (CertificateError, ops_from_assignment,
                                   verify_certificate)
from patchtool.matching import CostModel


def sample():
    old = FileTree({"a": ("x1", "x2"), "b": ("y1",), "c": ("z",)})
    new = FileTree({"a": ("y1",), "d": ("x1", "x2", "w"), "c": ("z", "z2")})
    return old, new, diff_trees(old, new)


class TestCertificateValid(unittest.TestCase):
    def test_valid_certificate_verifies(self):
        old, new, patch = sample()
        ops = [op_key(o) for o in patch["ops"]]
        self.assertTrue(verify_certificate(old, new, patch["certificate"],
                                           expected_ops=ops))

    def test_certificate_is_self_contained(self):
        # verification must not run the optimiser: sabotage the Hungarian
        # solver and show verification still works
        old, new, patch = sample()
        import patchtool.certificate as cert_mod
        import patchtool.matching as match_mod
        saved = match_mod.hungarian
        try:
            def boom(_):
                raise AssertionError("optimiser must not run during verify")
            match_mod.hungarian = boom
            cert_mod.hungarian = boom if hasattr(cert_mod, "hungarian") else None
            verify_certificate(old, new, patch["certificate"],
                               expected_ops=[op_key(o) for o in patch["ops"]])
        finally:
            match_mod.hungarian = saved


class TestCertificateTampered(unittest.TestCase):
    def setUp(self):
        self.old, self.new, self.patch = sample()
        self.ops = [op_key(o) for o in self.patch["ops"]]

    def assert_tamper_fails(self, mutate):
        cert = copy.deepcopy(self.patch["certificate"])
        mutate(cert)
        with self.assertRaises(CertificateError):
            verify_certificate(self.old, self.new, cert, expected_ops=self.ops)

    def test_tampered_cost(self):
        self.assert_tamper_fails(lambda c: c.update(cost=c["cost"] + 1))

    def test_tampered_row_potential(self):
        def mutate(c):
            c["u"][0] += 1
        self.assert_tamper_fails(mutate)

    def test_tampered_col_potential(self):
        def mutate(c):
            c["v"][-1] -= 1
        self.assert_tamper_fails(mutate)

    def test_tampered_assignment_not_permutation(self):
        def mutate(c):
            c["assignment"][0] = c["assignment"][1]
        self.assert_tamper_fails(mutate)

    def test_tampered_assignment_swap(self):
        def mutate(c):
            a = c["assignment"]
            a[0], a[1] = a[1], a[0]
        self.assert_tamper_fails(mutate)

    def test_tampered_labels(self):
        def mutate(c):
            c["rows"][0] = ["file", "nonexistent"]
        self.assert_tamper_fails(mutate)

    def test_tampered_src_hash(self):
        self.assert_tamper_fails(lambda c: c.update(src_hash="0" * 64))

    def test_tampered_dst_hash(self):
        self.assert_tamper_fails(lambda c: c.update(dst_hash="0" * 64))

    def test_wrong_expected_ops(self):
        old, new, patch = sample()
        with self.assertRaises(CertificateError):
            verify_certificate(old, new, patch["certificate"],
                               expected_ops=[("add", "bogus")])

    def test_wrong_trees(self):
        old, new, patch = sample()
        other = FileTree({"q": ("1",)})
        with self.assertRaises(CertificateError):
            verify_certificate(other, new, patch["certificate"])
        with self.assertRaises(CertificateError):
            verify_certificate(old, other, patch["certificate"])

    def test_forged_assignment_cannot_fake_optimality(self):
        # A suboptimal matching cannot be certified: derive its ops and try
        # to pass them off with the genuine potentials.
        old, new, patch = sample()
        model = CostModel(sorted(old.files.items()), sorted(new.files.items()))
        cert = copy.deepcopy(patch["certificate"])
        # force a different (suboptimal) assignment: rotate real rows
        n = model.n
        assignment = list(cert["assignment"])
        real_cols = [assignment[i] for i in range(n)]
        for i in range(n):
            assignment[i] = real_cols[(i + 1) % n]
        cert["assignment"] = assignment
        with self.assertRaises(CertificateError):
            verify_certificate(old, new, cert)


if __name__ == "__main__":
    unittest.main()
