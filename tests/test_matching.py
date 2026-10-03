"""Optimality and tie-break checked against full enumeration (<= 7 files)."""
import random
import unittest

from filepatch.matching import CertificateError, solve, verify_certificate

from helpers import brute_force_best, random_files


class BruteForceOptimalityTest(unittest.TestCase):
    def check_instance(self, source_files, target_files):
        result = solve(source_files, target_files)
        best_cost, best_ops = brute_force_best(source_files, target_files)
        self.assertEqual(result.cost, best_cost)
        # Tie-break: the normalized operation sequence (sorted canonical
        # operation tuple) must be the lexicographically smallest one
        # among all minimum-cost matchings.
        self.assertEqual(result.ops, best_ops)
        self.assertTrue(
            verify_certificate(
                source_files, target_files, result.certificate()
            )
        )

    def test_small_instances(self):
        rng = random.Random(20261004)
        sizes = [
            (0, 0), (1, 1), (1, 2), (2, 1), (2, 2), (2, 3), (3, 3),
            (4, 3), (3, 5), (4, 4), (5, 5), (6, 6),
        ]
        for ns, nt in sizes:
            for _ in range(3):
                source = random_files(rng, ns)
                target = random_files(rng, nt)
                with self.subTest(ns=ns, nt=nt, source=source, target=target):
                    self.check_instance(source, target)

    def test_seven_files(self):
        rng = random.Random(7)
        for _ in range(2):
            source = random_files(rng, 7)
            target = random_files(rng, 7)
            with self.subTest(source=source, target=target):
                self.check_instance(source, target)

    def test_mixed_seven(self):
        rng = random.Random(77)
        for ns, nt in [(7, 5), (5, 7), (7, 0), (0, 7), (6, 7)]:
            source = random_files(rng, ns)
            target = random_files(rng, nt)
            with self.subTest(ns=ns, nt=nt):
                self.check_instance(source, target)


class CertificateTamperTest(unittest.TestCase):
    def setUp(self):
        rng = random.Random(1234)
        self.source = random_files(rng, 4)
        self.target = random_files(rng, 4)
        self.cert = solve(self.source, self.target).certificate()

    def test_valid_certificate(self):
        self.assertTrue(
            verify_certificate(self.source, self.target, self.cert)
        )

    def test_tampered_row_potential(self):
        cert = dict(self.cert)
        cert["row_potentials"] = list(self.cert["row_potentials"])
        cert["row_potentials"][0] += 1
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, cert)

    def test_tampered_col_potential(self):
        cert = dict(self.cert)
        cert["col_potentials"] = list(self.cert["col_potentials"])
        cert["col_potentials"][-1] -= 1
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, cert)

    def test_tampered_cost(self):
        cert = dict(self.cert, cost=self.cert["cost"] + 1)
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, cert)

    def test_tampered_secondary(self):
        cert = dict(self.cert, secondary=self.cert["secondary"] + 1)
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, cert)

    def test_tampered_matching(self):
        cert = dict(self.cert)
        cert["matching"] = [list(pair) for pair in self.cert["matching"]]
        # Two rows claiming the same column: no longer a perfect matching.
        cert["matching"][0][1] = cert["matching"][1][1]
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, cert)

    def test_tampered_combined(self):
        cert = dict(self.cert, combined=self.cert["combined"] + 1)
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, cert)

    def test_malformed_certificate(self):
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, {"format": "nope"})
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, {})
        with self.assertRaises(CertificateError):
            verify_certificate(self.source, self.target, None)


if __name__ == "__main__":
    unittest.main()
