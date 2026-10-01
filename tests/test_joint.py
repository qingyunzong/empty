"""Acceptance C: joint-phase quorum needs both old and new majorities."""

import unittest

from rgroup import Group, NotInJoint, StaleConfig


class TestBeginChangeGuards(unittest.TestCase):
    def test_begin_with_wrong_old_is_stale(self):
        group = Group(["a", "b", "c"])
        with self.assertRaises(StaleConfig):
            group.begin_change(["a", "b"], ["a", "d", "e"])

    def test_begin_while_joint_in_flight_is_stale(self):
        group = Group(["a", "b", "c"])
        group.begin_change(["a", "b", "c"], ["a", "d", "e"])
        with self.assertRaises(StaleConfig):
            group.begin_change(["a", "b", "c"], ["a", "b", "d"])

    def test_commit_and_abort_require_joint(self):
        group = Group(["a", "b", "c"])
        with self.assertRaises(NotInJoint):
            group.commit_change()
        with self.assertRaises(NotInJoint):
            group.abort()


class TestJointQuorum(unittest.TestCase):
    def setUp(self):
        self.group = Group(["a", "b", "c"])
        self.group.begin_change(["a", "b", "c"], ["c", "d", "e"])

    def test_new_majority_without_old_majority_does_not_commit(self):
        # {d, e} is a majority of the new config {c, d, e} but only 1/3
        # of the old config {a, b, c}: the write must NOT commit.
        write = self.group.propose("v")
        self.assertFalse(self.group.ack(write.id, "d"))
        self.assertFalse(self.group.ack(write.id, "e"))
        self.assertFalse(write.committed)
        self.assertIsNone(self.group.read())

    def test_old_majority_without_new_majority_does_not_commit(self):
        write = self.group.propose("v")
        self.assertFalse(self.group.ack(write.id, "a"))
        self.assertFalse(self.group.ack(write.id, "b"))  # old majority only
        self.assertFalse(write.committed)

    def test_both_majorities_commit(self):
        write = self.group.propose("v")
        self.group.ack(write.id, "d")
        self.group.ack(write.id, "e")  # new majority, old 1/3
        self.assertFalse(write.committed)
        self.group.ack(write.id, "a")
        self.assertFalse(write.committed)  # old {a} still 1/3... need 2 of old
        self.assertTrue(self.group.ack(write.id, "c"))  # old {a,c}, new {c,d,e}
        self.assertEqual(self.group.read(), "v")


class TestCommitAndAbort(unittest.TestCase):
    def test_commit_activates_new_config(self):
        group = Group(["a", "b", "c"])
        group.begin_change(["a", "b", "c"], ["a", "d", "e"])
        config = group.commit_change()
        self.assertEqual(config.members, frozenset({"a", "d", "e"}))
        self.assertEqual(config.epoch, 2)
        # After commit, a majority of the NEW config alone suffices.
        write = group.propose("v")
        group.ack(write.id, "d")
        self.assertTrue(group.ack(write.id, "e"))

    def test_abort_rolls_back_and_keeps_confirmed_writes(self):
        group = Group(["a", "b", "c"])
        write = group.write("before", node="a")
        group.ack(write.id, "b")  # committed under old config
        group.begin_change(["a", "b", "c"], ["a", "d", "e"])
        joint_write = group.propose("during-joint")
        group.ack(joint_write.id, "a")
        group.ack(joint_write.id, "b")  # old majority
        group.ack(joint_write.id, "d")
        group.ack(joint_write.id, "e")  # new majority -> committed in joint
        self.assertTrue(joint_write.committed)
        config = group.abort()
        self.assertEqual(config.members, frozenset({"a", "b", "c"}))
        self.assertEqual(config.epoch, 1)
        # Confirmed writes survive the abort, in order.
        self.assertEqual([v for _, v in group.committed], ["before", "during-joint"])
        self.assertEqual(group.read(), "during-joint")
        # Old-config majority still suffices after rollback.
        w = group.propose("after")
        group.ack(w.id, "a")
        self.assertTrue(group.ack(w.id, "c"))


if __name__ == "__main__":
    unittest.main()
