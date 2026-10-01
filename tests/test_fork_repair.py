"""Acceptance B: after fork repair the committed prefix is preserved."""
import unittest

import _bootstrap  # noqa: F401
from raft_sim.core import Cluster, Entry, ProtocolError


def build_forked_cluster():
    """3 nodes; n1 ends up with an uncommitted fork entry b@2 (term 1)
    while the majority authoritative log has x@2 (term 2)."""
    c = Cluster(3)
    c.elect("n1", 1)
    c.append("a", 1)          # idx 1, term 1
    c.ack("n2")
    c.ack("n3")
    c.commit()                # commitIndex = 1 on the leader
    c.ack("n2")               # propagate commitIndex = 1
    c.ack("n3")
    c.append("b", 2)          # idx 2, term 1: only on n1
    c.crash("n1")
    c.elect("n2", 2)          # n2 + n3
    c.append("x", 9)          # idx 2, term 2: fork created
    c.ack("n3")               # n3 = [a, x]
    c.commit()                # idx 2 term 2 on n2,n3 -> commitIndex = 2
    c.ack("n3")               # propagate
    c.recover("n1")           # n1 = [a, b(t1)], commitIndex = 1
    return c


class TestForkRepair(unittest.TestCase):
    def test_reject_carries_conflict_index(self):
        c = build_forked_cluster()
        res = c.ack("n1")
        self.assertFalse(res["ack"])
        self.assertEqual(res["reason"], "REJECT")
        self.assertEqual(res["conflictIndex"], 2)
        self.assertEqual(res["conflictTerm"], 1)

    def test_repair_truncates_fork_and_keeps_committed_prefix(self):
        c = build_forked_cluster()
        committed = c.nodes["n1"].log[0]  # the committed entry "a"
        res = c.repair()
        n1 = c.nodes["n1"]
        self.assertEqual([e.key for e in n1.log], ["a", "x"])
        self.assertEqual(n1.log[0].term, committed.term)
        self.assertEqual(n1.log[0].index, committed.index)
        self.assertEqual(n1.log[0].key, committed.key)
        self.assertEqual(n1.commit_index, 2)
        truncated = {r["node"]: r["truncated"] for r in res["repaired"]}
        self.assertEqual(truncated["n1"], 1)
        # Every live node now holds the authoritative log.
        for name in ("n1", "n2", "n3"):
            self.assertEqual([e.key for e in c.nodes[name].log], ["a", "x"])

    def test_repair_never_deletes_committed_entries(self):
        c = Cluster(3)
        c.elect("n1", 1)
        c.append("a", 1)
        # Craft a node whose committed entry is absent from the
        # authoritative log: repair must refuse and leave it untouched.
        n2 = c.nodes["n2"]
        n2.log = [Entry(term=9, index=1, key="z", value=None)]
        n2.commit_index = 1
        with self.assertRaises(ProtocolError):
            c.repair()
        self.assertEqual([e.key for e in n2.log], ["z"])
        self.assertEqual(n2.commit_index, 1)


if __name__ == "__main__":
    unittest.main()
