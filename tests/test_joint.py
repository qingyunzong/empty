"""Acceptance C: joint consensus requires majorities of BOTH configs;
commit/abort boundaries behave correctly."""

import unittest

from repligroup.core import (
    Cluster,
    NoPendingChange,
    NotMember,
    StaleConfig,
)

OLD = ["a", "b", "c"]
NEW = ["d", "e", "f"]


class JointConsensusTest(unittest.TestCase):
    def setUp(self):
        self.cluster = Cluster(nodes=OLD)  # in-memory
        self.cluster.begin_change(OLD, NEW)

    def test_new_majority_alone_does_not_commit(self):
        seq, _ = self.cluster.propose("v")
        for node in ("d", "e", "f"):  # full new config, zero old members
            self.assertFalse(self.cluster.ack(node, seq))
        self.assertFalse(self.cluster.is_committed(seq))

    def test_old_majority_alone_does_not_commit(self):
        seq, _ = self.cluster.propose("v")
        for node in ("a", "b", "c"):  # full old config, zero new members
            self.assertFalse(self.cluster.ack(node, seq))
        self.assertFalse(self.cluster.is_committed(seq))

    def test_both_majorities_commit(self):
        seq, _ = self.cluster.propose("v")
        self.assertFalse(self.cluster.ack("d", seq))
        self.assertFalse(self.cluster.ack("e", seq))  # new majority reached
        self.assertFalse(self.cluster.ack("a", seq))
        self.assertTrue(self.cluster.ack("b", seq))  # old majority reached
        self.assertTrue(self.cluster.is_committed(seq))

    def test_commit_installs_new_config_with_fresh_epoch(self):
        joint_epoch = self.cluster.current_epoch
        new_epoch = self.cluster.commit_change()
        self.assertGreater(new_epoch, joint_epoch)
        self.assertEqual(sorted(self.cluster.members), NEW)
        self.assertEqual(self.cluster.phase, "stable")
        # single-config majority suffices again
        seq, _ = self.cluster.propose("post")
        self.assertFalse(self.cluster.ack("d", seq))
        self.assertTrue(self.cluster.ack("e", seq))

    def test_abort_rolls_back_without_losing_committed_writes(self):
        seq, _ = self.cluster.propose("kept")
        for node in ("a", "b", "d", "e"):
            self.cluster.ack(node, seq)
        self.assertTrue(self.cluster.is_committed(seq))
        epoch = self.cluster.abort_change()
        self.assertEqual(epoch, 1)
        self.assertEqual(sorted(self.cluster.members), OLD)
        state = self.cluster.read()
        self.assertEqual(state["value"], "kept")
        self.assertEqual(state["epoch"], 1)

    def test_commit_without_joint_fails(self):
        cluster = Cluster(nodes=OLD)
        with self.assertRaises(NoPendingChange):
            cluster.commit_change()

    def test_abort_without_joint_fails(self):
        cluster = Cluster(nodes=OLD)
        with self.assertRaises(NoPendingChange):
            cluster.abort_change()

    def test_double_begin_fails(self):
        with self.assertRaises(StaleConfig):
            self.cluster.begin_change(OLD, NEW)

    def test_begin_with_wrong_old_fails(self):
        cluster = Cluster(nodes=OLD)
        with self.assertRaises(StaleConfig):
            cluster.begin_change(["a", "b"], NEW)

    def test_non_voter_ack_rejected(self):
        seq, _ = self.cluster.propose("v")
        with self.assertRaises(NotMember):
            self.cluster.ack("outsider", seq)


if __name__ == "__main__":
    unittest.main()
