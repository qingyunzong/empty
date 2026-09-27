"""Acceptance D: a timed-out transaction is marked ABORTED and its
writes never become visible. Pending transactions are never treated as
unsatisfiable while still within their timeout."""

import unittest

from mvcc import MVCCStore, MvccError, ABORTED, ACTIVE


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class TimeoutTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = MVCCStore(num_replicas=1, time_fn=self.clock)

    def test_timeout_marks_aborted_and_hides_writes(self):
        self.store.begin("t1", ctx={}, timeout_ms=100)
        self.store.write("t1", "k", "ghost")
        self.assertEqual(self.store.txn_status("t1"), ACTIVE)

        self.clock.advance(0.2)  # 200ms > 100ms timeout
        self.assertEqual(self.store.txn_status("t1"), ABORTED)
        with self.assertRaises(MvccError) as cm:
            self.store.commit("t1")
        self.assertEqual(cm.exception.code, "TIMEOUT")

        # the aborted txn's write is invisible to fresh snapshots
        self.store.begin("r")
        self.assertIsNone(self.store.read("r", "k"))

    def test_expired_write_and_read_raise_timeout(self):
        self.store.begin("t1", ctx={}, timeout_ms=50)
        self.clock.advance(0.1)
        with self.assertRaises(MvccError) as cm:
            self.store.write("t1", "k", 1)
        self.assertEqual(cm.exception.code, "TIMEOUT")
        with self.assertRaises(MvccError) as cm:
            self.store.read("t1", "k")
        self.assertEqual(cm.exception.code, "TIMEOUT")
        self.assertEqual(self.store.txn_status("t1"), ABORTED)

    def test_pending_within_timeout_is_satisfiable(self):
        self.store.begin("t1", ctx={}, timeout_ms=1000)
        self.store.write("t1", "k", "v")
        self.clock.advance(0.5)  # 500ms < 1000ms: still pending, not failed
        vv = self.store.commit("t1")
        self.store.begin("r", ctx=vv)
        self.assertEqual(self.store.read("r", "k"), "v")

    def test_expired_txn_does_not_pin_gc_watermark(self):
        self.store.begin("w", ctx={})
        self.store.write("w", "k", 1)
        ctx1 = self.store.commit("w")
        self.store.begin("snap", ctx=ctx1, timeout_ms=50)
        self.store.begin("w2", ctx=ctx1)
        self.store.write("w2", "k", 2)
        self.store.commit("w2")
        self.clock.advance(0.1)  # snap expired
        _, collected = self.store.gc()
        self.assertEqual(collected, 1)  # expired snapshot must not pin k=1


if __name__ == "__main__":
    unittest.main()
