"""Acceptance B: writes carrying an old epoch are rejected; epochs are
unique and monotonically increasing across configurations."""

import unittest

from repligroup.core import Cluster, StaleEpoch, StaleConfig


class EpochMonotonicityTest(unittest.TestCase):
    def setUp(self):
        self.cluster = Cluster(nodes=["a", "b", "c"])  # in-memory

    def test_stale_epoch_propose_rejected_after_begin(self):
        self.cluster.write("v1")
        self.assertEqual(self.cluster.current_epoch, 1)
        self.cluster.begin_change(["a", "b", "c"], ["a", "b", "d"])
        self.assertEqual(self.cluster.current_epoch, 2)
        with self.assertRaises(StaleEpoch):
            self.cluster.propose("v2", epoch=1)

    def test_stale_epoch_ack_rejected_after_begin(self):
        seq, epoch = self.cluster.propose("v2")
        self.assertEqual(epoch, 1)
        self.cluster.begin_change(["a", "b", "c"], ["a", "b", "d"])
        with self.assertRaises(StaleEpoch):
            self.cluster.ack("a", seq)
        self.assertFalse(self.cluster.is_committed(seq))

    def test_stale_epoch_propose_rejected_after_commit(self):
        self.cluster.begin_change(["a", "b", "c"], ["a", "b", "d"])
        self.cluster.commit_change()
        self.assertEqual(self.cluster.current_epoch, 3)
        for stale in (1, 2):
            with self.assertRaises(StaleEpoch):
                self.cluster.propose("v", epoch=stale)

    def test_epochs_unique_and_increasing_even_across_abort(self):
        seen = [self.cluster.current_epoch]
        self.cluster.begin_change(["a", "b", "c"], ["a", "b", "d"])
        seen.append(self.cluster.current_epoch)
        self.cluster.abort_change()
        # abort returns to the old committed config without reusing epochs
        self.cluster.begin_change(["a", "b", "c"], ["a", "c", "e"])
        seen.append(self.cluster.current_epoch)
        self.cluster.commit_change()
        seen.append(self.cluster.current_epoch)
        self.assertEqual(seen, sorted(seen))
        self.assertEqual(len(seen), len(set(seen)))

    def test_begin_with_stale_old_config_rejected(self):
        self.cluster.begin_change(["a", "b", "c"], ["a", "b", "d"])
        self.cluster.commit_change()
        with self.assertRaises(StaleConfig):
            self.cluster.begin_change(["a", "b", "c"], ["a", "b", "e"])


if __name__ == "__main__":
    unittest.main()
