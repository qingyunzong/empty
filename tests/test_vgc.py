"""Acceptance tests for the vgc MVCC garbage collector.

Covers:
  a) GC while a long transaction is alive keeps its visible versions.
  b) After the long transaction commits, GC reclaims versions and
     reports correct statistics.
  c) as_of on an expired snapshot reports SNAPSHOT_EXPIRED.
  d) Random operation sequences match a keep-everything reference
     implementation for every active snapshot.
"""

import random
import unittest

from vgc import GC_DEFERRED, GC_OK, MVCCStore, SnapshotExpired


def commit_value(store, txn_id, key, value):
    """Helper: single-put transaction, returns commit_ts."""
    store.begin(txn_id)
    store.put(txn_id, key, value)
    return store.commit(txn_id)


class LongTransactionTest(unittest.TestCase):
    """Acceptance (a) and (b)."""

    def setUp(self):
        self.store = MVCCStore(max_versions=3)
        # k: v1@1, v2@2  -- then a long transaction snapshots at ts=2
        self.ts1 = commit_value(self.store, "t1", "k", "v1")
        self.ts2 = commit_value(self.store, "t2", "k", "v2")
        self.long_snap = self.store.begin("t_long")
        # newer versions created while t_long is alive
        self.ts3 = commit_value(self.store, "t3", "k", "v3")
        self.ts4 = commit_value(self.store, "t4", "k", "v4")

    def test_a_gc_preserves_versions_visible_to_long_transaction(self):
        report = self.store.gc()
        self.assertEqual(report["status"], GC_OK)
        self.assertEqual(report["low_watermark"], self.long_snap)
        # v1@1 is below the low_watermark and invisible to every active
        # snapshot -> reclaimed.  v2@2 is visible to t_long -> kept.
        self.assertEqual(report["reclaimed"], 1)
        self.assertEqual(self.store.as_of(self.long_snap, "k"), "v2")
        self.assertEqual(self.store.get("k"), "v4")
        # The reclaimed v1 can no longer be served.
        with self.assertRaises(SnapshotExpired):
            self.store.as_of(self.ts1, "k")

    def test_b_gc_reclaims_after_long_transaction_commits(self):
        self.store.gc()  # first GC while t_long is active
        self.store.put("t_long", "other", "x")
        self.store.commit("t_long")  # releases the snapshot

        report = self.store.gc()
        self.assertEqual(report["status"], GC_OK)
        self.assertEqual(report["low_watermark"], self.store.clock)
        # v2 and v3 are now obsolete; only the newest v4 survives.
        self.assertEqual(report["reclaimed"], 2)

        stats = self.store.stats()
        self.assertEqual(stats["versions"], 2)  # k -> v4, other -> x
        self.assertEqual(stats["reclaimed_total"], 3)
        self.assertEqual(stats["last_gc_reclaimed"], 2)
        self.assertEqual(stats["last_gc_status"], GC_OK)
        self.assertEqual(stats["active_snapshots"], [])
        self.assertEqual(stats["low_watermark"], self.store.clock)
        self.assertEqual(self.store.get("k"), "v4")
        with self.assertRaises(SnapshotExpired):
            self.store.as_of(self.ts2, "k")


class SnapshotExpiredTest(unittest.TestCase):
    """Acceptance (c)."""

    def test_c_as_of_reports_snapshot_expired_after_gc(self):
        store = MVCCStore(max_versions=1)
        ts1 = commit_value(store, "t1", "k", "v1")
        ts2 = commit_value(store, "t2", "k", "v2")
        commit_value(store, "t3", "k", "v3")

        store.gc()  # no active snapshots: only v3 survives

        with self.assertRaises(SnapshotExpired) as ctx:
            store.as_of(ts1, "k")
        self.assertIn("SNAPSHOT_EXPIRED", str(ctx.exception))
        with self.assertRaises(SnapshotExpired):
            store.as_of(ts2, "k")
        # The retained horizon itself is still queryable.
        self.assertEqual(store.as_of(store.clock, "k"), "v3")

    def test_as_of_unknown_key_is_not_expired(self):
        store = MVCCStore()
        commit_value(store, "t1", "k", "v1")
        store.gc()
        self.assertIsNone(store.as_of(0, "missing"))
        self.assertIsNone(store.as_of(0, "k"))  # predates k's first version


class MaxVersionsBudgetTest(unittest.TestCase):
    def test_deferred_when_budget_cannot_be_met(self):
        store = MVCCStore(max_versions=1)
        commit_value(store, "t1", "k", "v1")
        snap = store.begin("t_long")  # protects v1
        commit_value(store, "t2", "k", "v2")
        commit_value(store, "t3", "k", "v3")

        report = store.gc()
        # v1 (protected by snapshot) + v2 (>= low_watermark) + v3 (newest)
        # all survive; budget of 1 cannot be met -> GC_DEFERRED, no error.
        self.assertEqual(report["status"], GC_DEFERRED)
        self.assertEqual(report["deferred_keys"], ["k"])
        self.assertEqual(store.as_of(snap, "k"), "v1")

        store.commit("t_long")
        report = store.gc()
        self.assertEqual(report["status"], GC_OK)
        self.assertEqual(len(store.data["k"]), 1)
        self.assertEqual(store.get("k"), "v3")

    def test_budget_enforced_when_no_snapshots(self):
        store = MVCCStore(max_versions=2)
        for i in range(5):
            commit_value(store, f"t{i}", "k", f"v{i}")
        report = store.gc()
        self.assertEqual(report["status"], GC_OK)
        self.assertEqual(len(store.data["k"]), 1)  # only newest survives
        self.assertEqual(report["reclaimed"], 4)


class ReferenceModel:
    """Keep-everything reference implementation (no GC)."""

    def __init__(self):
        self.versions = {}  # key -> list of (commit_ts, value)

    def commit(self, commit_ts, writes):
        for key, value in writes.items():
            self.versions.setdefault(key, []).append((commit_ts, value))

    def visible(self, key, ts):
        result = None
        for commit_ts, value in self.versions.get(key, []):
            if commit_ts <= ts:
                result = value
            else:
                break
        return result


class RandomizedComparisonTest(unittest.TestCase):
    """Acceptance (d): random ops vs. keep-all reference model."""

    def test_d_random_ops_match_reference_for_all_active_snapshots(self):
        for seed in range(10):
            with self.subTest(seed=seed):
                self._run_seed(seed)

    def _run_seed(self, seed):
        rng = random.Random(seed)
        store = MVCCStore(max_versions=rng.randint(1, 3))
        ref = ReferenceModel()
        keys = [f"k{i}" for i in range(4)]
        active = {}  # txn_id -> snapshot_ts
        counter = 0

        def check_all_snapshots():
            # Every active snapshot must see exactly what the reference
            # sees, for every key ever written (GC must never reclaim a
            # version visible to an active snapshot).
            for snap_ts in active.values():
                for key in ref.versions:
                    try:
                        got = store.as_of(snap_ts, key)
                    except SnapshotExpired:
                        self.fail(
                            f"seed={seed} active snapshot {snap_ts} expired "
                            f"on key {key!r}"
                        )
                    want = ref.visible(key, snap_ts)
                    self.assertEqual(
                        got, want,
                        f"seed={seed} snapshot={snap_ts} key={key!r}",
                    )
            # Current reads must match too.
            for key in ref.versions:
                self.assertEqual(store.get(key), ref.visible(key, store.clock))

        for _ in range(600):
            action = rng.choice(
                ["begin", "put", "commit", "gc", "put", "commit"]
            )
            if action == "begin" or not active:
                counter += 1
                txn_id = f"t{counter}"
                active[txn_id] = store.begin(txn_id)
            elif action == "put":
                txn_id = rng.choice(list(active))
                store.put(txn_id, rng.choice(keys), rng.randint(0, 10**6))
            elif action == "commit":
                txn_id = rng.choice(list(active))
                commit_ts = store.commit(txn_id)
                ref.commit(commit_ts, store.txns[txn_id].writes)
                del active[txn_id]
            else:  # gc
                store.gc()
            check_all_snapshots()

        # Drain: commit everything, GC hard, then only the newest version
        # of each key may remain.
        for txn_id in list(active):
            commit_ts = store.commit(txn_id)
            ref.commit(commit_ts, store.txns[txn_id].writes)
            del active[txn_id]
        store.gc()
        for key, versions in store.data.items():
            self.assertEqual(len(versions), 1)
            self.assertEqual(versions[0].value, ref.visible(key, store.clock))


if __name__ == "__main__":
    unittest.main()
