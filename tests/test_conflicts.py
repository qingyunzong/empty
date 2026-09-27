"""Acceptance B: concurrent writes to the same key -> exactly one side
gets WRITE_SKEW. Also: pending transactions never block others."""

import unittest

from mvcc import MVCCStore, MvccError


class WriteConflictTest(unittest.TestCase):
    def test_concurrent_commit_second_loses(self):
        store = MVCCStore(num_replicas=2)
        store.begin("t1", ctx={}, replica="r0")
        store.begin("t2", ctx={}, replica="r1")
        store.write("t1", "k", "a")
        store.write("t2", "k", "b")
        store.commit("t1")
        with self.assertRaises(MvccError) as cm:
            store.commit("t2")
        self.assertEqual(cm.exception.code, "WRITE_SKEW")
        self.assertEqual(store.txn_status("t2"), "ABORTED")

    def test_write_after_concurrent_commit_fails_immediately(self):
        store = MVCCStore(num_replicas=2)
        store.begin("t1", ctx={}, replica="r0")
        store.begin("t2", ctx={}, replica="r1")
        store.write("t1", "k", "a")
        vv1 = store.commit("t1")
        with self.assertRaises(MvccError) as cm:
            store.write("t2", "k", "b")
        self.assertEqual(cm.exception.code, "WRITE_SKEW")

        # a txn whose ctx includes vv1 may overwrite normally
        store.begin("t3", ctx=vv1, replica="r1")
        store.write("t3", "k", "c")
        vv3 = store.commit("t3")
        store.begin("r", ctx=vv3)
        self.assertEqual(store.read("r", "k"), "c")

    def test_exactly_one_winner_among_many(self):
        for n in (2, 3, 5):
            store = MVCCStore(num_replicas=n)
            tids = ["t%d" % i for i in range(n)]
            for i, tid in enumerate(tids):
                store.begin(tid, ctx={}, replica="r%d" % i)
                store.write(tid, "hot", i)
            results = []
            for tid in tids:
                try:
                    store.commit(tid)
                    results.append("COMMITTED")
                except MvccError as exc:
                    self.assertEqual(exc.code, "WRITE_SKEW")
                    results.append("WRITE_SKEW")
            self.assertEqual(results.count("COMMITTED"), 1)
            self.assertEqual(results.count("WRITE_SKEW"), n - 1)

    def test_pending_transaction_does_not_block(self):
        store = MVCCStore(num_replicas=1)
        store.begin("pending", ctx={})
        store.write("pending", "k", "uncommitted")
        # another txn writes and commits the same key without conflict
        store.begin("t2", ctx={})
        store.write("t2", "k", "committed")
        vv = store.commit("t2")
        store.begin("r", ctx=vv)
        self.assertEqual(store.read("r", "k"), "committed")
        # the pending txn is still satisfiable on its own
        store.abort("pending")

    def test_disjoint_keys_no_conflict(self):
        store = MVCCStore(num_replicas=2)
        store.begin("t1", ctx={}, replica="r0")
        store.begin("t2", ctx={}, replica="r1")
        store.write("t1", "a", 1)
        store.write("t2", "b", 2)
        store.commit("t1")
        store.commit("t2")  # different key: no WRITE_SKEW


if __name__ == "__main__":
    unittest.main()
