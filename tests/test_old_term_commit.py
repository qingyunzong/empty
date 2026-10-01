"""Acceptance C: an entry from an older term stored on a majority is not
committed directly; it is committed only indirectly with a current-term
entry."""
import unittest

import _bootstrap  # noqa: F401
from raft_sim.core import Cluster


class TestOldTermCommit(unittest.TestCase):
    def test_old_term_majority_entry_not_committed_directly(self):
        c = Cluster(3)
        c.elect("n1", 1)
        c.append("x", "1")   # idx 1, term 1
        c.ack("n2")          # term-1 entry now on a majority (n1, n2)
        c.crash("n1")        # leader dies before committing
        c.elect("n2", 2)     # n2 (has x) + n3 -> leader of term 2
        c.recover("n1")      # x@1(term 1) is stored on n1 and n2: a majority
        res = c.commit()
        self.assertEqual(res["commitIndex"], 0,
                         "old-term entry on a majority must not commit")

        c.append("y", "2")   # idx 2, term 2 (current term)
        c.ack("n1")          # n1 = [x, y]
        res = c.commit()
        self.assertEqual(res["commitIndex"], 2,
                         "current-term majority entry commits")
        # The old-term entry x@1 is committed indirectly as a prefix.
        self.assertGreaterEqual(c.nodes["n2"].commit_index, 1)

    def test_commit_requires_current_term(self):
        c = Cluster(5)
        c.elect("n1", 1)
        c.append("old", 0)   # idx 1, term 1
        for f in ("n2", "n3", "n4"):
            c.ack(f)         # term-1 entry on 4/5 nodes
        c.crash("n1")
        c.elect("n2", 2)     # n2..n5 elect n2 (n2's log is up to date)
        self.assertEqual(c.commit()["commitIndex"], 0)
        c.append("new", 1)   # idx 2, term 2
        c.ack("n3")
        c.ack("n4")          # term-2 entry on 3/5: a majority
        self.assertEqual(c.commit()["commitIndex"], 2)


if __name__ == "__main__":
    unittest.main()
