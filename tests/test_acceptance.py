"""Acceptance scenarios from the specification."""

import random
import tempfile
import threading
import unittest
from pathlib import Path

from docstore import DocumentStore, PatchError

from tests.reference import full_scan, ref_apply


class AcceptanceCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "store"
        self.store = DocumentStore(self.dir, initial={})


class TestArrayHeadInsert(AcceptanceCase):
    def test_many_paths_shift_together(self):
        self.store.create_index("byV", "/arr/*/v")
        self.store.create_index("deep", "/arr/*/meta/*/tag")
        self.store.apply([{"op": "add", "path": "/arr", "value": [
            {"v": 1, "meta": [{"tag": "a"}, {"tag": "b"}]},
            {"v": 2, "meta": [{"tag": "c"}]},
            {"v": 3, "meta": []},
        ]}])
        self.store.apply([{"op": "add", "path": "/arr/0",
                           "value": {"v": 0, "meta": [{"tag": "z"}]}}])
        doc = self.store.get("")
        indexes = self.store._version.indexes
        for name in ("byV", "deep"):
            self.assertEqual(indexes[name].as_map(),
                             full_scan(doc, indexes[name].pattern_text))
        rows = self.store.query([{"index": "byV", "exists": True}],
                                sort_by="byV")
        self.assertEqual([r["path"] for r in rows],
                         ["/arr/0/v", "/arr/1/v", "/arr/2/v", "/arr/3/v"])
        self.assertEqual([r["value"] for r in rows], [0, 1, 2, 3])
        rows = self.store.query([{"index": "deep", "eq": "c"}])
        self.assertEqual(rows, [{"path": "/arr/2/meta/0/tag", "value": "c"}])


class TestIndexSwitchConcurrency(AcceptanceCase):
    def test_old_snapshot_queries_during_index_switch(self):
        self.store.create_index("byV", "/arr/*/v")
        self.store.apply([{"op": "add", "path": "/arr",
                           "value": [{"v": i} for i in range(20)]}])
        snap = self.store.open_snapshot()
        expected = snap.query([{"index": "byV", "exists": True}])
        self.assertEqual(len(expected), 20)
        errors = []
        stop = threading.Event()

        def builder():
            try:
                for n in range(5):
                    self.store.create_index(f"extra{n}", "/arr/*/v")
            except Exception as exc:  # pragma: no cover
                errors.append(exc)
            finally:
                stop.set()

        def patcher():
            try:
                for i in range(30):
                    self.store.apply([{"op": "add", "path": "/arr/-",
                                       "value": {"v": 100 + i}}])
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=builder),
                   threading.Thread(target=patcher)]
        for t in threads:
            t.start()
        while not stop.is_set():
            self.assertEqual(snap.query([{"index": "byV", "exists": True}]),
                             expected)
            self.assertEqual(snap.get("/arr/5/v"), 5)
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        # snapshot still pinned at its own version after the dust settles
        self.assertEqual(snap.query([{"index": "byV", "exists": True}]),
                         expected)
        self.assertEqual(snap.version, 1)
        self.assertEqual(self.store.version, 31)
        snap.release()


class TestReferenceCrossCheck(AcceptanceCase):
    """Random small batches: store vs independent reference interpreter,
    full-traversal index scans, versions and index entry counts."""

    PATTERNS = ["/a/*/v", "/a/*", "/b/*/0", "/*", "/a/*/tags/*"]

    def _random_value(self, rng, depth):
        if depth <= 0 or rng.random() < 0.4:
            return rng.choice([0, 1, 2, 7, 1.5, 2.0, True, False,
                               "x", "y", None])
        if rng.random() < 0.5:
            return {rng.choice("uvwx"): self._random_value(rng, depth - 1)
                    for _ in range(rng.randint(0, 3))}
        return [self._random_value(rng, depth - 1)
                for _ in range(rng.randint(0, 3))]

    def _random_ops(self, rng, doc):
        ops = []
        for _ in range(rng.randint(1, 4)):
            kind = rng.choice(["add", "add", "replace", "remove",
                               "move", "test"])
            target = rng.choice(["/a", "/b", "/a/0", "/a/1", "/b/0"])
            if kind == "add":
                ops.append({"op": "add", "path": target,
                            "value": self._random_value(rng, 2)})
            elif kind == "replace":
                ops.append({"op": "replace", "path": target,
                            "value": self._random_value(rng, 1)})
            elif kind == "remove":
                ops.append({"op": "remove", "path": target})
            elif kind == "move":
                dst = rng.choice(["/c", "/b/0", "/a/9"])
                ops.append({"op": "move", "from": target, "path": dst})
            else:
                ops.append({"op": "test", "path": "/a",
                            "value": doc.get("a")})
        return ops

    def test_cross_check(self):
        rng = random.Random(20261001)
        for name in ("p%d" % i for i in range(len(self.PATTERNS))):
            self.store.create_index(name, self.PATTERNS[int(name[1:])])
        ref_doc = {}
        expected_version = 0
        for _ in range(60):
            ops = self._random_ops(rng, ref_doc)
            try:
                ref_next = ref_apply(ref_doc, ops)
            except Exception:
                with self.assertRaises(PatchError):
                    self.store.apply(ops)
                continue
            version = self.store.apply(ops)
            ref_doc = ref_next
            expected_version += 1
            self.assertEqual(version, expected_version)
            self.assertEqual(self.store.version, expected_version)
            doc = self.store.get("")
            self.assertEqual(doc, ref_doc)
            indexes = self.store._version.indexes
            for i, pattern in enumerate(self.PATTERNS):
                idx = indexes["p%d" % i]
                scanned = full_scan(ref_doc, pattern)
                self.assertEqual(idx.as_map(), scanned,
                                 f"index {pattern} diverged")
                self.assertEqual(idx.entry_count(), len(scanned))
            # query results match a filter over the full scan
            scanned = full_scan(ref_doc, "/a/*/v")
            for probe in (0, 1, 2, 1.5, True, "x", None):
                want = sorted(p for p, v in scanned.items()
                              if type(v) is type(probe) and v == probe)
                got = sorted(r["path"] for r in self.store.query(
                    [{"index": "p0", "eq": probe}]))
                self.assertEqual(got, want)
            exists = self.store.query([{"index": "p0", "exists": True}])
            self.assertEqual(sorted(r["path"] for r in exists),
                             sorted(scanned))
        # persistence: reopen and re-verify everything
        reopened = DocumentStore(self.dir)
        self.assertEqual(reopened.version, expected_version)
        self.assertEqual(reopened.get(""), ref_doc)
        for i, pattern in enumerate(self.PATTERNS):
            idx = reopened._version.indexes["p%d" % i]
            self.assertEqual(idx.as_map(), full_scan(ref_doc, pattern))


if __name__ == "__main__":
    unittest.main()
