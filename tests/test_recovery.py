"""Crash-recovery tests driven by injectable interrupt points."""

import tempfile
import unittest
from pathlib import Path

from docstore import DocumentStore


class InjectedCrash(Exception):
    pass


def crash_at(point):
    def hook(*args):
        raise InjectedCrash(point)
    return hook


class RecoveryCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "store"

    def reopen(self, hooks=None):
        return DocumentStore(self.dir, hooks=hooks)


class TestWalRecovery(RecoveryCase):
    def test_log_half_written_tmp_ignored(self):
        store = self.reopen()
        store.apply([{"op": "add", "path": "/a", "value": 1}])
        store2 = DocumentStore(self.dir,
                               hooks={"wal_tmp_written": crash_at("x")})
        with self.assertRaises(InjectedCrash):
            store2.apply([{"op": "replace", "path": "/a", "value": 2}])
        # tmp file may remain; the committed state must be version 1
        recovered = self.reopen()
        self.assertEqual(recovered.version, 1)
        self.assertEqual(recovered.get("/a"), 1)

    def test_committed_but_unpublished_replayed(self):
        store = self.reopen()
        store.apply([{"op": "add", "path": "/a", "value": 1}])
        store2 = DocumentStore(self.dir,
                               hooks={"wal_committed": crash_at("x")})
        with self.assertRaises(InjectedCrash):
            store2.apply([{"op": "replace", "path": "/a", "value": 2}])
        # WAL record was durable; recovery replays it
        recovered = self.reopen()
        self.assertEqual(recovered.version, 2)
        self.assertEqual(recovered.get("/a"), 2)

    def test_corrupt_tail_record_ignored(self):
        store = self.reopen()
        store.apply([{"op": "add", "path": "/a", "value": 1}])
        store.apply([{"op": "replace", "path": "/a", "value": 2}])
        wal2 = self.dir / "wal" / f"{2:020d}.json"
        wal2.write_text('{"version": 2, "ops": [garbage')
        recovered = self.reopen()
        self.assertEqual(recovered.version, 1)
        self.assertEqual(recovered.get("/a"), 1)
        # and the store keeps accepting new batches afterwards
        recovered.apply([{"op": "replace", "path": "/a", "value": 3}])
        self.assertEqual(self.reopen().get("/a"), 3)


class TestIndexPublishRecovery(RecoveryCase):
    def test_index_built_but_not_published(self):
        store = self.reopen()
        store.apply([{"op": "add", "path": "/arr",
                      "value": [{"v": 1}, {"v": 2}]}])
        store2 = DocumentStore(
            self.dir, hooks={"before_index_publish": crash_at("x")})
        with self.assertRaises(InjectedCrash):
            store2.create_index("byV", "/arr/*/v")
        recovered = self.reopen()
        self.assertEqual(recovered.list_indexes(), {})
        self.assertEqual(recovered.version, 1)
        # index creation can be retried cleanly
        recovered.create_index("byV", "/arr/*/v")
        rows = recovered.query([{"index": "byV", "eq": 2}])
        self.assertEqual(rows, [{"path": "/arr/1/v", "value": 2}])
        self.assertEqual(self.reopen().list_indexes(),
                         {"byV": "/arr/*/v"})


class TestReclaimRecovery(RecoveryCase):
    def test_published_but_not_reclaimed(self):
        store = self.reopen()
        store.apply([{"op": "add", "path": "/a", "value": 1}])
        store2 = DocumentStore(self.dir,
                               hooks={"after_publish": crash_at("x")})
        with self.assertRaises(InjectedCrash):
            store2.apply([{"op": "replace", "path": "/a", "value": 2}])
        recovered = self.reopen()
        self.assertEqual(recovered.version, 2)
        self.assertEqual(recovered.get("/a"), 2)
        recovered.reclaim()
        again = self.reopen()
        self.assertEqual(again.version, 2)
        self.assertEqual(again.get("/a"), 2)
        self.assertEqual(list((self.dir / "wal").glob("*.json")), [])

    def test_crash_during_reclaim_keeps_consistency(self):
        store = self.reopen()
        for i in range(3):
            store.apply([{"op": "add" if i == 0 else "replace",
                          "path": "/a", "value": i}])
        store2 = DocumentStore(
            self.dir, hooks={"reclaim_base_written": crash_at("x")})
        with self.assertRaises(InjectedCrash):
            store2.reclaim()
        # base snapshot written, WAL not yet truncated: replay must skip
        # records already covered by the base and stay consistent
        recovered = self.reopen()
        self.assertEqual(recovered.version, 3)
        self.assertEqual(recovered.get("/a"), 2)
        recovered.reclaim()
        self.assertEqual(self.reopen().get("/a"), 2)


if __name__ == "__main__":
    unittest.main()
