"""Acceptance D: crash after log append but before vote persist.

After recovery the node must not be elected on the basis of an unpersisted
vote, and its term must not roll back illegally (it comes back with exactly
its durable term/vote).
"""
import unittest

import _bootstrap  # noqa: F401
from raft_sim.core import Cluster, ProtocolError

FAULT = lambda node: {"node": node, "point": "before_vote_persist"}  # noqa: E731


class TestCrashRecovery(unittest.TestCase):
    def test_unpersisted_vote_does_not_elect(self):
        c = Cluster(3)
        c.elect("n1", 1)
        c.append("e1", "v1")
        c.ack("n2")          # n2's log append is durable
        c.crash("n3")        # only n1's vote can save the election
        # n2 runs for term 2; n1 crashes before its vote is persisted.
        res = c.elect("n2", 2, fault=FAULT("n1"))
        self.assertFalse(res["elected"])
        self.assertEqual(res["votes"], ["n2"])   # n1's vote was lost
        self.assertFalse(c.nodes["n1"].alive)
        self.assertIsNone(c.leader())

        rec = c.recover("n1")
        # Term must not roll back illegally: exactly the durable term 1
        # (not 0, and not the unpersisted term 2).
        self.assertEqual(rec["term"], 1)
        self.assertEqual(rec["votedFor"], "n1")  # durable self-vote of term 1
        self.assertEqual(rec["logLength"], 1)    # appended log survived
        self.assertEqual(c.nodes["n1"].role, "follower")

        # The same election now succeeds once the vote is persisted.
        c.recover("n3")
        res = c.elect("n2", 2)
        self.assertTrue(res["elected"])
        self.assertEqual(c.nodes["n1"].current_term, 2)
        self.assertEqual(c.nodes["n1"].voted_for, "n2")

    def test_candidate_crash_before_self_vote_persist(self):
        c = Cluster(3)
        c.elect("n1", 1)
        c.append("e1", "v1")
        c.ack("n2")
        c.elect("n2", 2)     # n1 grants: durable term 2, voted_for n2
        # n1 runs for term 3 but crashes before persisting its self-vote.
        res = c.elect("n1", 3, fault=FAULT("n1"))
        self.assertFalse(res["elected"])
        self.assertEqual(res["crashed"], "n1")

        rec = c.recover("n1")
        self.assertEqual(rec["term"], 2)         # durable term, no rollback
        self.assertEqual(rec["votedFor"], "n2")
        # The unpersisted candidacy must not make n1 a leader.
        self.assertNotEqual(c.nodes["n1"].role, "leader")
        self.assertEqual(c.leader().name, "n2")
        with self.assertRaises(ProtocolError):
            c.append("bad", None, leader="n1")

    def test_recovered_node_rejoins_replication(self):
        c = Cluster(3)
        c.elect("n1", 1)
        c.append("e1", "v1")
        c.ack("n2")
        c.commit()
        c.crash("n2")
        c.append("e2", "v2")
        c.ack("n3")
        c.commit()
        c.recover("n2")
        res = c.ack("n2")
        self.assertTrue(res["ack"])
        self.assertEqual([e.key for e in c.nodes["n2"].log], ["e1", "e2"])
        self.assertEqual(c.nodes["n2"].commit_index, 2)


if __name__ == "__main__":
    unittest.main()
