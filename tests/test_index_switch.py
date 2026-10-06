import tempfile
import threading
import unittest

from jsondoc import DocumentStore, Faults, QueryError


class IndexSwitchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.faults = Faults()
        self.store = DocumentStore(self.tmp.name, faults=self.faults)
        self.addCleanup(self.store.close)

    def test_catchup_and_atomic_switch(self):
        self.store.put("d1", {"tags": ["a"], "n": 1})
        self.store.put("d2", {"tags": ["b"], "n": 2})
        snap = self.store.snapshot()
        self.addCleanup(snap.close)

        scanning = threading.Event()
        proceed = threading.Event()

        def hook(point):
            scanning.set()
            proceed.wait(10)

        self.faults.set("index_build_scan", hook)
        errors = []

        def build():
            try:
                self.store.create_index("by_tag", "/tags/*")
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        thread = threading.Thread(target=build)
        thread.start()
        self.assertTrue(scanning.wait(10))

        # while the index is building it is not visible yet
        with self.assertRaises(QueryError):
            self.store.query({"where": [{"eq": ["by_tag", "a"]}]})
        # old snapshot queries keep working during the build
        self.assertEqual(snap.query({"where": [{"exists": "/n"}]}), ["d1", "d2"])
        # a patch lands in the middle of the build
        self.store.apply("d1", [{"op": "add", "path": "/tags/-", "value": "c"}])
        proceed.set()
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])

        # the patch committed during the build was caught up via the log
        self.assertEqual(self.store.query({"where": [{"eq": ["by_tag", "c"]}]}), ["d1"])
        self.assertEqual(self.store.query({"where": [{"eq": ["by_tag", "a"]}]}), ["d1"])
        self.assertEqual(self.store.query({"where": [{"eq": ["by_tag", "b"]}]}), ["d2"])
        # the snapshot taken at the build base sees the index as of its version
        self.assertEqual(snap.query({"where": [{"eq": ["by_tag", "a"]}]}), ["d1"])
        self.assertEqual(snap.query({"where": [{"eq": ["by_tag", "c"]}]}), [])

    def test_concurrent_snapshot_queries_during_switch(self):
        for i in range(5):
            self.store.put("doc%d" % i, {"n": i, "grp": "g%d" % (i % 2)})
        snap = self.store.snapshot()
        self.addCleanup(snap.close)
        errors = []
        stop = threading.Event()

        def reader():
            try:
                while not stop.is_set():
                    self.assertEqual(
                        snap.query({"where": [{"exists": "/n"}]}),
                        ["doc0", "doc1", "doc2", "doc3", "doc4"],
                    )
                    self.store.query({"where": [{"exists": "/grp"}]})
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        readers = [threading.Thread(target=reader) for _ in range(3)]
        for r in readers:
            r.start()
        self.store.create_index("by_grp", "/grp")
        self.store.apply("doc0", [{"op": "replace", "path": "/n", "value": 100}])
        stop.set()
        for r in readers:
            r.join(10)
        self.assertEqual(errors, [])
        # snapshot still pinned to the old version
        self.assertEqual(snap.get("doc0"), {"n": 0, "grp": "g0"})
        self.assertEqual(self.store.get("doc0")["n"], 100)
        self.assertEqual(
            self.store.query({"where": [{"eq": ["by_grp", "g1"]}]}),
            ["doc1", "doc3"],
        )


if __name__ == "__main__":
    unittest.main()

