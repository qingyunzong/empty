import unittest

from mvcc import MVCCStore, StoreLimitExceeded, TxnAborted, TxnNotActive, WriteSkew


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class TestConcurrentWriteConflict(unittest.TestCase):
    """Acceptance B: concurrent writes to the same key -> one WRITE_SKEW."""

    def _concurrent_pair(self):
        # t1 snapshots at (0,0) on replica 0; t2 snapshots at (0,1) on
        # replica 1, so t1's commit (1,0) is concurrent with t2's ctx.
        s = MVCCStore(num_replicas=2)
        s.begin("seed", replica=1)
        s.write("seed", "other", "o")
        seed_ctx = s.commit("seed")  # (0, 1)
        s.begin("t1", replica=0)
        s.begin("t2", replica=1, ctx=list(seed_ctx))
        return s

    def test_write_after_concurrent_commit_fails(self):
        s = self._concurrent_pair()
        s.write("t1", "k", "v1")
        s.commit("t1")  # version (1, 0)
        # t2's snapshot (0,1) is concurrent with (1,0)
        with self.assertRaises(WriteSkew):
            s.write("t2", "k", "v2")

    def test_commit_time_conflict(self):
        s = self._concurrent_pair()
        s.write("t1", "k", "v1")
        s.write("t2", "k", "v2")  # ok: t1 not yet committed
        s.commit("t1")
        with self.assertRaises(WriteSkew):
            s.commit("t2")
        # t2 stays active after failed commit and can abort cleanly
        s.abort("t2")
        self.assertEqual(s.txn_state("t2"), "aborted")

    def test_exactly_one_of_two_concurrent_writers_succeeds(self):
        s = self._concurrent_pair()
        s.write("t1", "k", "v1")
        s.write("t2", "k", "v2")
        results = []
        for tid in ("t1", "t2"):
            try:
                s.commit(tid)
                results.append((tid, "ok"))
            except WriteSkew:
                results.append((tid, "skew"))
        outcomes = sorted(r for _, r in results)
        self.assertEqual(outcomes, ["ok", "skew"])

    def test_causally_ordered_writes_do_not_conflict(self):
        s = MVCCStore(num_replicas=2)
        s.begin("t1", replica=0)
        s.write("t1", "k", "v1")
        ctx = s.commit("t1")  # (1, 0)
        s.begin("t2", replica=1, ctx=list(ctx))
        s.write("t2", "k", "v2")  # snapshot dominates (1,0): no conflict
        ctx2 = s.commit("t2")  # (1, 1)
        s.begin("t3", ctx=list(ctx2))
        found, value, _ = s.read("t3", "k")
        self.assertTrue(found)
        self.assertEqual(value, "v2")

    def test_pending_writes_never_conflict(self):
        # Uncommitted writes of other transactions must not make a write
        # unsatisfiable.
        s = MVCCStore(num_replicas=2)
        s.begin("t1", replica=0)
        s.begin("t2", replica=1)
        s.write("t1", "k", "v1")
        s.write("t2", "k", "v2")  # no WRITE_SKEW from t1's pending write
        s.abort("t1")
        s.commit("t2")  # t1 aborted: no committed concurrent version
        s.begin("t3", ctx=[0, 1])
        found, value, _ = s.read("t3", "k")
        self.assertEqual((found, value), (True, "v2"))


class TestGC(unittest.TestCase):
    """Acceptance C: active snapshots pin versions; closing them frees GC."""

    def _store_with_history(self):
        s = MVCCStore(num_replicas=2)
        ctx = None
        for i in range(3):
            s.begin(f"w{i}", replica=0, ctx=ctx)
            s.write(f"w{i}", "k", f"v{i}")
            ctx = list(s.commit(f"w{i}"))  # (1,0), (2,0), (3,0)
        return s

    def test_active_snapshot_blocks_gc(self):
        s = self._store_with_history()
        s.begin("reader", ctx=[1, 0])  # pins version (1,0)
        collected = s.gc()
        self.assertEqual(collected, 0)
        self.assertEqual(s.version_count("k"), 3)
        # watermark is the reader's snapshot
        self.assertEqual(s.gc_watermark(), (1, 0))

    def test_gc_after_snapshot_close(self):
        s = self._store_with_history()
        s.begin("reader", ctx=[1, 0])
        s.gc()
        s.abort("reader")  # close the snapshot
        collected = s.gc()
        self.assertEqual(collected, 2)  # (1,0) and (2,0) collected
        self.assertEqual(s.version_count("k"), 1)
        self.assertIsNone(s.gc_watermark())  # no active snapshots

    def test_gc_keeps_newest_below_watermark(self):
        s = self._store_with_history()
        s.begin("reader", ctx=[2, 0])
        collected = s.gc()
        self.assertEqual(collected, 1)  # only (1,0) removed
        vecs = sorted(v.vec for v in s.versions("k"))
        self.assertEqual(vecs, [(2, 0), (3, 0)])
        # reader still sees the newest version at/below its snapshot
        found, value, _ = s.read("reader", "k")
        self.assertEqual((found, value), (True, "v1"))

    def test_gc_preserves_concurrent_versions(self):
        s = MVCCStore(num_replicas=2)
        s.begin("a", replica=0)
        s.write("a", "k", "va")
        s.commit("a")  # (1,0)
        s.begin("b", replica=1)
        s.write("b", "k", "vb")
        s.commit("b")  # (0,1), concurrent with (1,0)
        s.gc()  # no active snapshots
        self.assertEqual(s.version_count("k"), 2)  # both maxima survive


class TestTimeout(unittest.TestCase):
    """Acceptance D: timed-out transactions become ABORTED, writes invisible."""

    def test_timeout_marks_aborted_and_hides_writes(self):
        clock = FakeClock()
        s = MVCCStore(num_replicas=1, now_fn=clock)
        s.begin("t1", replica=0, timeout_ms=100)
        s.write("t1", "k", "v1")
        clock.advance(0.2)  # 200ms > 100ms
        with self.assertRaises(TxnAborted):
            s.commit("t1")
        self.assertEqual(s.txn_state("t1"), "aborted")
        # its writes are invisible to later transactions
        s.begin("t2", ctx=[0])
        found, _, _ = s.read("t2", "k")
        self.assertFalse(found)

    def test_timeout_on_read_and_write(self):
        clock = FakeClock()
        s = MVCCStore(num_replicas=1, now_fn=clock)
        s.begin("t1", replica=0, timeout_ms=50)
        clock.advance(0.1)
        with self.assertRaises(TxnAborted):
            s.read("t1", "k")
        with self.assertRaises(TxnAborted):
            s.write("t1", "k", "v")

    def test_no_timeout_when_within_deadline(self):
        clock = FakeClock()
        s = MVCCStore(num_replicas=1, now_fn=clock)
        s.begin("t1", replica=0, timeout_ms=1000)
        s.write("t1", "k", "v1")
        clock.advance(0.5)
        ctx = s.commit("t1")
        self.assertEqual(ctx, (1,))

    def test_expired_txn_releases_gc_watermark(self):
        clock = FakeClock()
        s = MVCCStore(num_replicas=1, now_fn=clock)
        s.begin("w", replica=0)
        s.write("w", "k", "v1")
        s.commit("w")
        s.begin("reader", ctx=[0], timeout_ms=50)
        self.assertEqual(s.gc_watermark(), (0,))
        clock.advance(0.1)
        self.assertIsNone(s.gc_watermark())  # expired snapshot no longer pins


class TestLimitsAndLifecycle(unittest.TestCase):
    def test_key_limit(self):
        s = MVCCStore(num_replicas=1, max_keys=3)
        for i in range(3):
            s.begin(f"t{i}")
            s.write(f"t{i}", f"k{i}", i)
            s.commit(f"t{i}")
        s.begin("t3")
        s.write("t3", "k3", 3)
        with self.assertRaises(StoreLimitExceeded):
            s.commit("t3")

    def test_abort_has_no_side_effects(self):
        s = MVCCStore(num_replicas=1)
        s.begin("t1")
        s.write("t1", "k", "v")
        s.abort("t1")
        self.assertEqual(s.version_count(), 0)
        s.begin("t2")
        found, _, _ = s.read("t2", "k")
        self.assertFalse(found)

    def test_ops_on_finished_txn_rejected(self):
        s = MVCCStore(num_replicas=1)
        s.begin("t1")
        s.commit("t1")
        with self.assertRaises(TxnNotActive):
            s.read("t1", "k")
        with self.assertRaises(TxnNotActive):
            s.write("t1", "k", 1)

    def test_read_picks_newest_visible_version(self):
        s = MVCCStore(num_replicas=1)
        ctx = None
        for i in range(3):
            s.begin(f"t{i}", ctx=ctx)
            s.write(f"t{i}", "k", f"v{i}")
            ctx = list(s.commit(f"t{i}"))
        s.begin("r", ctx=[2])
        found, value, vec = s.read("r", "k")
        self.assertEqual((found, value, vec), (True, "v1", (2,)))


if __name__ == "__main__":
    unittest.main()
