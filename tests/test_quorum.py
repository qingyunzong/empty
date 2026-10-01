"""Acceptance A: enumerate every majority subset for <=5-node groups."""

import itertools
import unittest

from repligroup.core import Cluster, is_majority


def subsets(nodes):
    for r in range(len(nodes) + 1):
        for combo in itertools.combinations(nodes, r):
            yield set(combo)


class MajoritySubsetsTest(unittest.TestCase):
    def test_every_subset_commits_iff_majority(self):
        for n in range(1, 6):
            nodes = [f"n{i}" for i in range(n)]
            for subset in subsets(nodes):
                with self.subTest(n=n, subset=sorted(subset)):
                    cluster = Cluster(nodes=nodes)  # in-memory
                    seq, _ = cluster.propose("v")
                    for node in sorted(subset):
                        cluster.ack(node, seq)
                    self.assertEqual(
                        cluster.is_committed(seq),
                        is_majority(len(subset), n),
                    )

    def test_majority_definition(self):
        expected = {1: 1, 2: 2, 3: 2, 4: 3, 5: 3}
        for n, quorum in expected.items():
            for count in range(0, n + 1):
                self.assertEqual(is_majority(count, n), count >= quorum)

    def test_any_two_majorities_intersect(self):
        for n in range(1, 6):
            nodes = [f"n{i}" for i in range(n)]
            majorities = [s for s in subsets(nodes) if is_majority(len(s), n)]
            self.assertEqual(len(majorities), sum(1 for _ in majorities))
            for a, b in itertools.combinations(majorities, 2):
                self.assertTrue(
                    a & b, f"disjoint majorities in {n}-node group: {a} {b}"
                )


if __name__ == "__main__":
    unittest.main()
