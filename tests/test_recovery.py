import os
import tempfile
import unittest

from mvview import Engine, Storage
from model import check_engine_vs_model


def recover_from(directory):
    engine = Engine()
    replayed = Storage.recover(engine, directory)
    return engine, replayed


class TestRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def _committed_engine(self, batches):
        storage = Storage(self.dir)
        engine = Engine(storage)
        for b in batches:
            engine.apply_batch(b)
        return engine, storage

    def test_replay_committed_batches(self):
        batches = [
            {"left_insert": [{"id": 1, "cid": "a", "value": 3}],
             "right_insert": [{"cid": "a", "group": "g"}]},
            {"left_insert": [{"id": 2, "cid": "a", "value": 5}]},
            {"left_replace": [{"id": 2, "cid": "a", "value": 8}]},
        ]
        live, storage = self._committed_engine(batches)
        storage.close()

        restored, replayed = recover_from(self.dir)
        self.assertEqual(replayed, 3)
        self.assertEqual(restored.view(), live.view())
        self.assertEqual(restored.batch_id, 3)
        self.assertEqual(restored.outputs, live.outputs)
        check_engine_vs_model(self, restored)

    def test_checkpoint_then_replay_only_newer_batches(self):
        live, storage = self._committed_engine([
            {"left_insert": [{"id": 1, "cid": "a", "value": 1}],
             "right_insert": [{"cid": "a", "group": "g"}]},
            {"left_insert": [{"id": 2, "cid": "a", "value": 2}]},
        ])
        storage.checkpoint(live)
        live.apply_batch({"left_insert": [{"id": 3, "cid": "a", "value": 4}]})
        live.apply_batch({"left_retract": [1]})
        storage.close()

        restored, replayed = recover_from(self.dir)
        self.assertEqual(replayed, 2)  # only batches after the checkpoint
        self.assertEqual(restored.view(), live.view())
        # recovering again must not double-count committed batches
        again, replayed2 = recover_from(self.dir)
        self.assertEqual(replayed2, 2)
        self.assertEqual(again.view(), live.view())
        check_engine_vs_model(self, restored)

    def test_uncommitted_log_tail_is_ignored(self):
        live, storage = self._committed_engine([
            {"left_insert": [{"id": 1, "cid": "a", "value": 1}],
             "right_insert": [{"cid": "a", "group": "g"}]},
        ])
        # crash mid-batch: batch record written, commit record lost
        storage.simulate_uncommitted_tail(2, {"left_insert": [{"id": 2, "cid": "a", "value": 99}]})
        storage.close()

        restored, replayed = recover_from(self.dir)
        self.assertEqual(replayed, 1)
        self.assertEqual(restored.view(), live.view())
        self.assertEqual(restored.batch_id, 1)
        check_engine_vs_model(self, restored)

    def test_recovery_continues_sequential_batch_ids(self):
        live, storage = self._committed_engine([
            {"left_insert": [{"id": 1, "cid": "a", "value": 1}],
             "right_insert": [{"cid": "a", "group": "g"}]},
        ])
        storage.close()
        restored, _ = recover_from(self.dir)
        restored.apply_batch({"left_insert": [{"id": 2, "cid": "a", "value": 2}]})
        self.assertEqual(restored.batch_id, 2)
        self.assertEqual(restored.outputs[-1]["batch_id"], 2)
        check_engine_vs_model(self, restored)

    def test_wal_files_written(self):
        live, storage = self._committed_engine([
            {"left_insert": [{"id": 1, "cid": "a", "value": 1}]},
        ])
        storage.checkpoint(live)
        storage.close()
        self.assertTrue(os.path.exists(os.path.join(self.dir, "wal.jsonl")))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "checkpoint.json")))


if __name__ == "__main__":
    unittest.main()
