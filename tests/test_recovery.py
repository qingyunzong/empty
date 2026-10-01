import json
import os
import tempfile
import unittest
from fractions import Fraction

from model import apply_to_model, engine_view_tuples, reference_view
from mvview import BatchError, Engine


def sample_batches():
    return [
        [
            {"op": "insert_cust", "customer": "c1", "group": "A"},
            {"op": "insert_cust", "customer": "c2", "group": "B", "count": 2},
            {"op": "insert_tx", "txid": "t1", "customer": "c1", "value": 10},
            {"op": "insert_tx", "txid": "t2", "customer": "c2", "value": 4},
        ],
        [
            {"op": "insert_tx", "txid": "t3", "customer": "c1",
             "value": {"num": 3, "den": 2}},
            {"op": "insert_tx", "txid": "t4", "customer": None, "value": 99},
            {"op": "migrate", "customer": "c2", "from": "B", "to": "A",
             "count": 1},
        ],
        [
            {"op": "replace_tx", "txid": "t1", "customer": "c2", "value": 7},
            {"op": "insert_cust", "customer": "c3", "group": None},
            {"op": "insert_tx", "txid": "t5", "customer": "c3",
             "value": None},
        ],
        [
            {"op": "retract_tx", "txid": "t2"},
            {"op": "retract_cust", "customer": "c2", "group": "B"},
        ],
    ]


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mvview-")

    def _run_batches(self, eng, batches, left, right):
        for ops in batches:
            eng.apply_batch(ops)
            apply_to_model(ops, left, right)

    def test_full_replay_without_checkpoint(self):
        eng = Engine.open(self.dir)
        left, right = {}, {}
        self._run_batches(eng, sample_batches(), left, right)
        version = eng.version
        reopened = Engine.open(self.dir)
        self.assertEqual(reopened.version, version)
        self.assertEqual(engine_view_tuples(reopened),
                         reference_view(left, right))
        self.assertEqual(reopened.left, left)
        self.assertEqual(reopened.right, right)

    def test_checkpoint_then_replay_suffix(self):
        batches = sample_batches()
        eng = Engine.open(self.dir)
        left, right = {}, {}
        self._run_batches(eng, batches[:2], left, right)
        eng.checkpoint()
        self._run_batches(eng, batches[2:], left, right)
        version = eng.version
        reopened = Engine.open(self.dir)
        self.assertEqual(reopened.version, version)
        self.assertEqual(engine_view_tuples(reopened),
                         reference_view(left, right))

    def test_committed_batches_not_counted_twice(self):
        eng = Engine.open(self.dir)
        left, right = {}, {}
        self._run_batches(eng, sample_batches(), left, right)
        eng.checkpoint()
        expected = engine_view_tuples(eng)
        for _ in range(3):
            reopened = Engine.open(self.dir)
            self.assertEqual(engine_view_tuples(reopened), expected)
            self.assertEqual(reopened.version, eng.version)

    def test_uncommitted_log_tail_ignored(self):
        eng = Engine.open(self.dir)
        left, right = {}, {}
        self._run_batches(eng, sample_batches()[:2], left, right)
        version = eng.version
        wal = os.path.join(self.dir, "wal.log")
        with open(wal, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "type": "begin", "batch": version + 1,
                "ops": [{"op": "insert_tx", "txid": "ghost",
                         "customer": "c1", "value": 1000}]}) + "\n")
            fh.write('{"type": "begin", "bat')
        reopened = Engine.open(self.dir)
        self.assertEqual(reopened.version, version)
        self.assertEqual(engine_view_tuples(reopened),
                         reference_view(left, right))
        self.assertNotIn("ghost", reopened.left)

    def test_failed_batch_leaves_wal_untouched(self):
        eng = Engine.open(self.dir)
        left, right = {}, {}
        self._run_batches(eng, sample_batches()[:2], left, right)
        wal = os.path.join(self.dir, "wal.log")
        with open(wal, "rb") as fh:
            before = fh.read()
        version = eng.version
        with self.assertRaises(BatchError):
            eng.apply_batch([
                {"op": "insert_tx", "txid": "tx", "customer": "c1",
                 "value": 1},
                {"op": "retract_tx", "txid": "missing"},
            ])
        with open(wal, "rb") as fh:
            self.assertEqual(fh.read(), before)
        self.assertEqual(eng.version, version)

    def test_recovery_after_every_write(self):
        batches = sample_batches()
        left, right = {}, {}
        for idx, ops in enumerate(batches):
            eng = Engine.open(self.dir)
            eng.apply_batch(ops)
            apply_to_model(ops, left, right)
            if idx == 1:
                eng.checkpoint()
            del eng
            reopened = Engine.open(self.dir)
            self.assertEqual(engine_view_tuples(reopened),
                             reference_view(left, right),
                             f"after batch {idx}")
            self.assertEqual(reopened.version, idx + 1)
            del reopened

    def test_checkpoint_value_exactness(self):
        eng = Engine.open(self.dir)
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c", "group": "G"},
            {"op": "insert_tx", "txid": "t", "customer": "c",
             "value": {"num": 1, "den": 3}},
        ])
        eng.checkpoint()
        reopened = Engine.open(self.dir)
        self.assertEqual(reopened.view()["G"]["sum"], Fraction(1, 3))


if __name__ == "__main__":
    unittest.main()
