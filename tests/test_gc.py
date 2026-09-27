"""Acceptance C: an active snapshot pins versions below the GC watermark;
once it closes, collectable versions are reclaimed."""

import unittest

from mvcc import MVCCStore


def populate(store, values):
    """Commit values[0], values[1], ... to key 'k', each causally after
    the previous. Returns the last commit ctx."""
    ctx = {}
    for v in values:
        tid = "w%d" % v
        store.begin(tid, ctx=ctx)
        store.write(tid, "k", v)
        ctx = store.commit(tid)
    return ctx


class GCTest(unittest.TestCase):
    def test_active_snapshot_blocks_gc(self):
        store = MVCCStore(num_replicas=1)
        ctx1 = populate(store, [1])
        store.begin("snap", ctx=ctx1)          # pins the k=1 view
        populate_ctx = ctx1
        # commit newer versions causally after ctx1
        store.begin("w2", ctx=populate_ctx)
        store.write("w2", "k", 2)
        ctx2 = store.commit("w2")
        store.begin("w3", ctx=ctx2)
        store.write("w3", "k", 3)
        store.commit("w3")

        self.assertEqual(store.version_count("k"), 3)
        watermark, collected = store.gc()
        self.assertEqual(collected, 0, "active snapshot must pin old versions")
        self.assertEqual(watermark, ctx1)
        self.assertEqual(store.version_count("k"), 3)
        # the pinned snapshot still reads its own view
        self.assertEqual(store.read("snap", "k"), 1)

        # closing the snapshot unblocks collection
        store.abort("snap")
        watermark, collected = store.gc()
        self.assertEqual(collected, 2)
        self.assertEqual(store.version_count("k"), 1)
        store.begin("latest")
        self.assertEqual(store.read("latest", "k"), 3)

    def test_watermark_is_componentwise_min(self):
        store = MVCCStore(num_replicas=2)
        store.begin("a", ctx={"r0": 5, "r1": 2})
        store.begin("b", ctx={"r0": 3, "r1": 7})
        self.assertEqual(store.gc_watermark(), {"r0": 3, "r1": 2})
        store.abort("a")
        self.assertEqual(store.gc_watermark(), {"r0": 3, "r1": 7})

    def test_gc_keeps_newest_visible_per_key(self):
        store = MVCCStore(num_replicas=1)
        populate(store, [1, 2, 3, 4])
        _, collected = store.gc()
        self.assertEqual(collected, 3)
        self.assertEqual(store.version_count("k"), 1)
        store.begin("r")
        self.assertEqual(store.read("r", "k"), 4)

    def test_gc_never_removes_only_version(self):
        store = MVCCStore(num_replicas=1)
        populate(store, [1])
        _, collected = store.gc()
        self.assertEqual(collected, 0)
        self.assertEqual(store.version_count("k"), 1)

    def test_gc_after_commit_releases_snapshot(self):
        store = MVCCStore(num_replicas=1)
        ctx1 = populate(store, [1])
        store.begin("snap", ctx=ctx1)
        store.write("snap", "other", "x")     # snapshot txn commits too
        store.commit("snap")
        populate_ctx = ctx1
        store.begin("w2", ctx=populate_ctx)
        store.write("w2", "k", 2)
        store.commit("w2")
        _, collected = store.gc()
        self.assertEqual(collected, 1)        # k=1 no longer pinned


if __name__ == "__main__":
    unittest.main()
