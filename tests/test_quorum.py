"""Acceptance A: enumerate all majority subsets for <=5 nodes, verify quorum."""

import itertools
import unittest

from rgroup import Group, is_majority


def subsets(nodes):
    for r in range(len(nodes) + 1):
        for combo in itertools.combinations(nodes, r):
            yield set(combo)


class TestQuorumEnumeration(unittest.TestCase):
    def test_is_majority_matches_strict_majority(self):
        for n in range(1, 6):
            nodes = list(range(n))
            for subset in subsets(nodes):
                self.assertEqual(
                    is_majority(subset, nodes),
                    len(subset) * 2 > n,
                    msg=f"n={n} subset={subset}",
                )

    def test_any_two_majorities_intersect(self):
        for n in range(1, 6):
            nodes = list(range(n))
            majorities = [s for s in subsets(nodes) if is_majority(s, nodes)]
            for first, second in itertools.product(majorities, repeat=2):
                self.assertTrue(
                    first & second,
                    msg=f"n={n}: disjoint majorities {first} {second}",
                )

    def test_write_commits_exactly_at_majority(self):
        for n in range(1, 6):
            nodes = [f"n{i}" for i in range(n)]
            for subset in subsets(nodes):
                group = Group(nodes)
                write = group.propose("v")
                for node in subset:
                    group.ack(write.id, node)
                self.assertEqual(
                    write.committed,
                    is_majority(subset, nodes),
                    msg=f"n={n} acks={subset}",
                )

    def test_commit_threshold_is_hit_exactly(self):
        # A write must flip to committed exactly when the ack set first
        # becomes a majority, not before.
        nodes = ["a", "b", "c", "d", "e"]
        group = Group(nodes)
        write = group.propose("v")
        self.assertFalse(group.ack(write.id, "a"))
        self.assertFalse(group.ack(write.id, "b"))
        self.assertTrue(group.ack(write.id, "c"))  # 3/5: first majority
        self.assertTrue(group.ack(write.id, "d"))  # idempotent


if __name__ == "__main__":
    unittest.main()
