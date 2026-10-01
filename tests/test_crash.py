"""Acceptance D: crash before config fsync recovers pre-crash committed state."""

import os
import tempfile
import unittest

from rgroup import CrashError, Group


class TestCrashRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = self.tmp.name

    def test_crash_before_config_fsync_recovers_old_config(self):
        group = Group(["a", "b", "c"], path=self.path)
        group._persist()  # initial committed config (epoch 1) hits disk
        write = group.write("committed-value", node="a")
        group.ack(write.id, "b")  # committed + fsynced at epoch 1

        group.begin_change(["a", "b", "c"], ["a", "d", "e"])
        group.failpoint = "before_config_fsync"
        with self.assertRaises(CrashError):
            group.commit_change()  # crashes before the config record fsync

        recovered = Group.load(self.path)
        self.assertEqual(recovered.config.epoch, 1)
        self.assertEqual(recovered.config.members, frozenset({"a", "b", "c"}))
        self.assertIsNone(recovered.joint)
        # Committed writes survive; nothing unconfirmed leaked to disk.
        self.assertEqual([v for _, v in recovered.committed], ["committed-value"])
        self.assertEqual(recovered.read(), "committed-value")

    def test_unconfirmed_writes_never_persisted(self):
        group = Group(["a", "b", "c"], path=self.path)
        group._persist()
        group.write("durable", node="a")
        group.ack(1, "b")  # committed
        pending = group.propose("volatile")  # no quorum: memory only
        group.ack(pending.id, "a")  # 1/3 acks, still uncommitted

        recovered = Group.load(self.path)
        self.assertEqual(recovered.read(), "durable")
        self.assertEqual(len(recovered.committed), 1)
        self.assertEqual(recovered.writes, {})  # pending write is gone

    def test_recovery_roundtrip_across_committed_changes(self):
        group = Group(["a", "b", "c"], path=self.path)
        group._persist()
        group.begin_change(["a", "b", "c"], ["a", "d", "e"])
        group.commit_change()  # epoch 2 fsynced
        write = group.write("v2", node="d")
        group.ack(write.id, "e")

        recovered = Group.load(self.path)
        self.assertEqual(recovered.config.epoch, 2)
        self.assertEqual(recovered.config.members, frozenset({"a", "d", "e"}))
        self.assertEqual(recovered.read(), "v2")
        # Recovered group keeps working: epoch still monotonic.
        recovered.begin_change(["a", "d", "e"], ["b", "d", "e"])
        self.assertEqual(recovered.commit_change().epoch, 3)

    def test_state_file_is_valid_after_each_commit(self):
        group = Group(["a", "b", "c"], path=self.path)
        group._persist()
        for i in range(3):
            write = group.write(f"v{i}", node="a")
            group.ack(write.id, "b")
            # Disk state is loadable after every committed write.
            self.assertEqual(Group.load(self.path).read(), f"v{i}")
        self.assertTrue(os.path.exists(os.path.join(self.path, "state.json")))


if __name__ == "__main__":
    unittest.main()
