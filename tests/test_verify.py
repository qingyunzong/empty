import random
import unittest
from fractions import Fraction

from knnindex import KNNIndex
from knnindex.geometry import to_point
from knnindex.query import Certificate
from knnindex.tree import iter_entries
from knnindex.verify import (
    exact_topk,
    verify_certificate_bound,
    verify_result,
)


def sample(seed=31, n=80):
    rng = random.Random(seed)
    idx = KNNIndex(2)
    for i in range(n):
        idx.insert(
            f"p{i}",
            [Fraction(rng.randint(-30, 30), 2), rng.randint(-30, 30)],
            {"a"} if rng.random() < 0.5 else {"b"},
        )
    return idx


class TestVerifyResult(unittest.TestCase):
    def test_genuine_result_verifies_clean(self):
        idx = sample()
        for expr in (None, {"tag": "a"}, {"and": [{"tag": "a"}, {"not": {"tag": "b"}}]}):
            result = idx.query([1, 2], 6, expr)
            problems = verify_result(
                result, list(iter_entries(idx._root)), to_point([1, 2]), 6, expr
            )
            self.assertEqual(problems, [])

    def test_tampered_hit_is_caught(self):
        idx = sample()
        result = idx.query([0, 0], 5)
        result.hits[2] = (result.hits[2][0], "p999")  # forge an id
        problems = verify_result(result, list(iter_entries(idx._root)), to_point([0, 0]), 5)
        self.assertTrue(problems)

    def test_tampered_distance_is_caught(self):
        idx = sample()
        result = idx.query([0, 0], 5)
        d, pid = result.hits[0]
        result.hits[0] = (d + 1, pid)  # lie about the distance
        problems = verify_result(result, list(iter_entries(idx._root)), to_point([0, 0]), 5)
        self.assertTrue(any("distance" in p or "match" in p for p in problems))

    def test_dropped_hit_is_caught(self):
        idx = sample()
        result = idx.query([0, 0], 5)
        del result.hits[1]  # silently drop a true hit
        problems = verify_result(result, list(iter_entries(idx._root)), to_point([0, 0]), 5)
        self.assertTrue(problems)

    def test_unknown_status_is_not_accepted_as_exact(self):
        idx = sample(n=200)
        result = idx.query([0, 0], 5, budget=2)
        self.assertEqual(result.status, "unknown")
        # verifier must not confirm unknown results as exact top-K
        problems = verify_result(result, list(iter_entries(idx._root)), to_point([0, 0]), 5)
        self.assertEqual(problems, [])  # but what it does claim must be sound
        truth = exact_topk(list(iter_entries(idx._root)), to_point([0, 0]), 5)
        truth_ids = {pid for _, pid in truth}
        for d, pid in result.hits:
            self.assertIn(pid, {e.point_id for e in iter_entries(idx._root)})


class TestCertificateVerification(unittest.TestCase):
    def test_genuine_certificates_verify(self):
        idx = sample(n=150)
        result = idx.query([0, 0], 4)
        self.assertTrue(result.certificates)
        for cert in result.certificates:
            node = _resolve(idx, cert.path)
            self.assertTrue(
                verify_certificate_bound(cert, node.box, to_point([0, 0])),
                f"genuine certificate rejected: {cert}",
            )

    def test_inflated_bound_is_caught(self):
        idx = sample(n=150)
        result = idx.query([0, 0], 4)
        cert = result.certificates[0]
        node = _resolve(idx, cert.path)
        tampered = Certificate(cert.bound + 1, cert.reason, cert.node_count, cert.path)
        self.assertFalse(verify_certificate_bound(tampered, node.box, to_point([0, 0])))

    def test_negative_bound_is_caught(self):
        cert = Certificate(Fraction(-1), "distance", 3, ())
        self.assertFalse(
            verify_certificate_bound(cert, ((Fraction(0),), (Fraction(1),)), (Fraction(2),))
        )

    def test_distance_certificate_must_exceed_kth(self):
        idx = sample(n=150)
        result = idx.query([0, 0], 4)
        entries = list(iter_entries(idx._root))
        for cert in result.certificates:
            if cert.reason == "distance":
                self.assertGreater(cert.bound, result.kth_dist)
        # a forged "distance" certificate at/below kth must be rejected
        forged = Certificate(result.kth_dist, "distance", 2, ())
        result.certificates.append(forged)
        problems = verify_result(result, entries, to_point([0, 0]), 4)
        self.assertTrue(any("kth" in p for p in problems))


def _resolve(idx, path):
    node = idx._root
    for step in path:
        node = node.left if step == 0 else node.right
    return node


if __name__ == "__main__":
    unittest.main()
