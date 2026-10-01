"""Acceptance (c): committing an already-committed txn raises TXN_STATE."""

import unittest

from mvcc import (
    READ_COMMITTED,
    SNAPSHOT,
    InvalidModeError,
    Store,
    TxnStateError,
    UnknownTxnError,
)


class TestTxnState(unittest.TestCase):
    def test_double_commit_raises_txn_state(self):
        store = Store()
        t = store.begin(SNAPSHOT)
        store.put(t, "k", "v")
        store.commit(t)
        with self.assertRaises(TxnStateError) as ctx:
            store.commit(t)
        self.assertEqual(ctx.exception.code, "TXN_STATE")

    def test_commit_after_abort_raises_txn_state(self):
        store = Store()
        t = store.begin(READ_COMMITTED)
        store.abort(t)
        with self.assertRaises(TxnStateError):
            store.commit(t)

    def test_abort_after_commit_raises_txn_state(self):
        store = Store()
        t = store.begin(READ_COMMITTED)
        store.commit(t)
        with self.assertRaises(TxnStateError):
            store.abort(t)

    def test_ops_on_finished_txn_raise_txn_state(self):
        store = Store()
        t = store.begin(READ_COMMITTED)
        store.put(t, "k", "v")
        store.commit(t)
        for op in (
            lambda: store.get(t, "k"),
            lambda: store.put(t, "k", "v2"),
            lambda: store.delete(t, "k"),
        ):
            with self.assertRaises(TxnStateError):
                op()

    def test_unknown_txn(self):
        store = Store()
        with self.assertRaises(UnknownTxnError) as ctx:
            store.get(999, "k")
        self.assertEqual(ctx.exception.code, "UNKNOWN_TXN")

    def test_invalid_mode(self):
        store = Store()
        with self.assertRaises(InvalidModeError) as ctx:
            store.begin("serializable")
        self.assertEqual(ctx.exception.code, "INVALID_MODE")

    def test_commit_ts_is_globally_monotonic(self):
        store = Store()
        stamps = []
        for _ in range(5):
            t = store.begin(READ_COMMITTED)
            store.put(t, "k", "v")
            stamps.append(store.commit(t))
        self.assertEqual(stamps, sorted(stamps))
        self.assertEqual(len(set(stamps)), len(stamps))


if __name__ == "__main__":
    unittest.main()
