"""Acceptance (b): after abort, the transaction's writes are invisible."""

import unittest

from mvcc import READ_COMMITTED, SNAPSHOT, Store


class TestAbort(unittest.TestCase):
    def test_aborted_writes_invisible(self):
        store = Store()
        t0 = store.begin(READ_COMMITTED)
        store.put(t0, "keep", "v0")
        store.commit(t0)
        t1 = store.begin(READ_COMMITTED)
        store.put(t1, "keep", "dirty")
        store.put(t1, "new", "dirty")
        store.delete(t1, "keep")
        store.abort(t1)
        rc = store.begin(READ_COMMITTED)
        self.assertEqual(store.get(rc, "keep"), "v0")
        self.assertIsNone(store.get(rc, "new"))
        snap = store.begin(SNAPSHOT)
        self.assertEqual(store.get(snap, "keep"), "v0")
        self.assertIsNone(store.get(snap, "new"))

    def test_abort_leaves_no_versions(self):
        store = Store()
        t = store.begin(READ_COMMITTED)
        store.put(t, "k", "v")
        store.delete(t, "k")
        store.abort(t)
        self.assertEqual(store.versions("k"), [])
        self.assertEqual(store.commit_ts, 0)

    def test_delete_writes_tombstone_not_physical_delete(self):
        store = Store()
        t1 = store.begin(READ_COMMITTED)
        store.put(t1, "k", "v")
        store.commit(t1)
        t2 = store.begin(READ_COMMITTED)
        store.delete(t2, "k")
        store.commit(t2)
        versions = store.versions("k")
        self.assertEqual(len(versions), 2)
        self.assertTrue(versions[1].deleted)
        rc = store.begin(READ_COMMITTED)
        self.assertIsNone(store.get(rc, "k"))


if __name__ == "__main__":
    unittest.main()
