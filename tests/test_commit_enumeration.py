"""Acceptance A: majority-commit enumeration vs. a reference state machine.

For every cluster size n in 1..4 we enumerate log layouts (per-node lists of
entry terms) and current terms, then compare the commit index computed by
``Cluster.commit`` (the real protocol path) against an independent reference
implementation of the rule:

    commitIndex = max N such that a majority of the n nodes are alive and
    store an entry at N whose term == the leader's current term.

The enumeration is exhaustive for up to 5 total log entries (terms in
{1,2,3}, current term in {1,2,3,4}) and randomized (seeded) for 6..12 total
entries, including crashed-node masks.
"""
import itertools
import random
import unittest

import _bootstrap  # noqa: F401
from raft_sim.core import Cluster, Entry

TERMS = (1, 2, 3)
CURRENT_TERMS = (1, 2, 3, 4)
EXHAUSTIVE_MAX_TOTAL = 5
RANDOM_MAX_TOTAL = 12
RANDOM_CASES = 3000
RANDOM_SEED = 20261001


def reference_commit_index(logs, cluster_size, current_term, alive):
    """Independent reference: logs are plain lists of terms per node."""
    best = 0
    for idx in range(1, len(logs[0]) + 1):  # logs[0] is the leader's log
        stored = sum(
            1 for log, up in zip(logs, alive)
            if up and len(log) >= idx and log[idx - 1] == current_term)
        if stored > cluster_size // 2:
            best = idx
    return best


def cluster_commit_index(logs, current_term, alive=None):
    """Commit index via the real Cluster protocol path (node 0 = leader)."""
    cluster = Cluster(len(logs))
    for node, terms in zip(cluster.nodes.values(), logs):
        node.log = [Entry(term=t, index=i + 1, key=f"k{i + 1}", value=None)
                    for i, t in enumerate(terms)]
    if alive is not None:
        for node, up in zip(cluster.nodes.values(), alive):
            node.alive = up
    leader = cluster.nodes["n1"]
    leader.role = "leader"
    leader.current_term = current_term
    return cluster.commit()["commitIndex"]


def length_tuples(n, total):
    """All n-tuples of non-negative integers summing exactly to total."""
    if n == 1:
        yield (total,)
        return
    for first in range(total + 1):
        for rest in length_tuples(n - 1, total - first):
            yield (first,) + rest


def split_terms(flat, lengths):
    logs, pos = [], 0
    for length in lengths:
        logs.append(list(flat[pos:pos + length]))
        pos += length
    return logs


class TestCommitEnumeration(unittest.TestCase):
    def test_exhaustive_up_to_5_entries(self):
        cases = 0
        for n in range(1, 5):
            for total in range(EXHAUSTIVE_MAX_TOTAL + 1):
                for lengths in length_tuples(n, total):
                    for flat in itertools.product(TERMS, repeat=total):
                        logs = split_terms(flat, lengths)
                        for current_term in CURRENT_TERMS:
                            got = cluster_commit_index(logs, current_term)
                            want = reference_commit_index(
                                logs, n, current_term, [True] * n)
                            self.assertEqual(
                                got, want,
                                f"n={n} logs={logs} term={current_term}")
                            cases += 1
        self.assertGreater(cases, 100000)  # prove the enumeration is real

    def test_randomized_up_to_12_entries_with_crashes(self):
        rng = random.Random(RANDOM_SEED)
        for case in range(RANDOM_CASES):
            n = rng.randint(1, 4)
            logs, remaining = [], RANDOM_MAX_TOTAL
            for _ in range(n):
                length = rng.randint(0, remaining)
                remaining -= length
                logs.append([rng.randint(1, 4) for _ in range(length)])
            current_term = rng.randint(1, 5)
            alive = [True] + [rng.random() < 0.8 for _ in range(n - 1)]
            got = cluster_commit_index(logs, current_term, alive)
            want = reference_commit_index(logs, n, current_term, alive)
            self.assertEqual(got, want,
                             f"n={n} logs={logs} term={current_term} "
                             f"alive={alive}")

    def test_commit_never_decreases(self):
        cluster = Cluster(3)
        cluster.elect("n1", 1)
        cluster.append("a", 1)
        cluster.ack("n2")
        self.assertEqual(cluster.commit()["commitIndex"], 1)
        cluster.crash("n2")  # lose the replica: quorum no longer visible
        self.assertEqual(cluster.commit()["commitIndex"], 1)


if __name__ == "__main__":
    unittest.main()
