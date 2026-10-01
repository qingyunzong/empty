"""Acceptance B: writes at old epochs are rejected; epochs are monotonic."""

import unittest

from rgroup import Group, StaleConfig


class TestEpochMonotonicity(unittest.TestCase):
    def test_epochs_unique_and_increasing(self):
        group = Group(["a", "b", "c"])
        self.assertEqual(group.config.epoch, 1)
        epochs = [group.config.epoch]
        group.begin_change(["a", "b", "c"], ["a", "b", "d"])
        epochs.append(group.commit_change().epoch)
        group.begin_change(["a", "b", "d"], ["a", "d", "e"])
        epochs.append(group.commit_change().epoch)
        self.assertEqual(epochs, [1, 2, 3])
        self.assertEqual(len(set(epochs)), len(epochs))
        self.assertEqual(epochs, sorted(epochs))

    def test_abort_does_not_advance_epoch(self):
        group = Group(["a", "b", "c"])
        group.begin_change(["a", "b", "c"], ["a", "b", "d"])
        group.abort()
        self.assertEqual(group.config.epoch, 1)
        # The same change can be retried and committed afterwards.
        group.begin_change(["a", "b", "c"], ["a", "b", "d"])
        self.assertEqual(group.commit_change().epoch, 2)


class TestStaleWritesRejected(unittest.TestCase):
    def _advanced_group(self):
        group = Group(["a", "b", "c"])
        group.begin_change(["a", "b", "c"], ["a", "d", "e"])
        group.commit_change()  # epoch 2, members {a, d, e}
        return group

    def test_write_via_removed_node_rejected(self):
        group = self._advanced_group()
        with self.assertRaises(StaleConfig):
            group.write("v", node="b")  # b stuck at epoch 1

    def test_write_via_current_node_accepted(self):
        group = self._advanced_group()
        write = group.write("v", node="d")
        self.assertEqual(write.epoch, 2)

    def test_old_epoch_write_ack_rejected_after_commit(self):
        group = Group(["a", "b", "c"])
        write = group.propose("v")  # epoch 1, no acks yet
        group.begin_change(["a", "b", "c"], ["a", "d", "e"])
        group.commit_change()
        with self.assertRaises(StaleConfig):
            group.ack(write.id, "a")
        self.assertFalse(write.committed)
        self.assertIsNone(group.read())

    def test_stale_node_ack_rejected(self):
        group = self._advanced_group()
        write = group.propose("v")  # epoch 2
        with self.assertRaises(StaleConfig):
            group.ack(write.id, "c")  # c left behind at epoch 1


if __name__ == "__main__":
    unittest.main()
