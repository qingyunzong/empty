import os
import tempfile
import unittest

from jsondoc import DocumentStore, Faults, InjectedFault


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.faults = Faults()
        self.store = DocumentStore(self.tmp.name, faults=self.faults)

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass

    def reopen(self):
        self.faults.clear()
        self.store = DocumentStore(self.tmp.name, faults=self.faults)

    def log_path(self):
        return os.path.join(self.tmp.name, "log.jsonl")

    def seed(self):
        self.store.put("d", {"n": 1})
        self.store.create_index("by_n", "/n")

    def test_torn_log_tail_discarded(self):
        self.seed()
        self.store.apply("d", [{"op": "replace", "path": "/n", "value": 2}])
        # simulate a half-written log record at the tail
        with open(self.log_path(), "a", encoding="utf-8") as fh:
            fh.write("12345 {\"kind\": \"pat")
        self.reopen()
        self.assertEqual(self.store.latest, 2)
        self.assertEqual(self.store.get("d"), {"n": 2})
        # store keeps working; the torn tail is gone
        self.store.apply("d", [{"op": "replace", "path": "/n", "value": 3}])
        self.assertEqual(self.store.get("d"), {"n": 3})

    def test_crash_after_log_append_replays(self):
        self.seed()
        self.faults.set("after_log_append")
        with self.assertRaises(InjectedFault):
            self.store.apply("d", [{"op": "replace", "path": "/n", "value": 42}])
        self.reopen()
        # the logged record is replayed during recovery
        self.assertEqual(self.store.get("d"), {"n": 42})
        self.assertEqual(self.store.query({"where": [{"eq": ["by_n", 42]}]}), ["d"])
        self.reopen()  # replayed version was published exactly once
        self.assertEqual(self.store.get("d"), {"n": 42})
        self.assertEqual(self.store.latest, 2)

    def test_crash_after_index_built_before_publish(self):
        self.seed()
        self.faults.set("after_index_built")
        with self.assertRaises(InjectedFault):
            self.store.apply("d", [{"op": "replace", "path": "/n", "value": 7}])
        self.reopen()
        # index was built but the version was never published: the WAL
        # record is replayed and the index rebuilt incrementally
        self.assertEqual(self.store.get("d"), {"n": 7})
        self.assertEqual(self.store.query({"where": [{"eq": ["by_n", 7]}]}), ["d"])
        self.assertEqual(self.store.latest, 2)

    def test_crash_after_publish_before_reclaim(self):
        self.seed()
        self.faults.set("after_publish")
        with self.assertRaises(InjectedFault):
            self.store.apply("d", [{"op": "replace", "path": "/n", "value": 9}])
        self.reopen()
        # published version survives; no duplicate replay, log cleared
        self.assertEqual(self.store.latest, 2)
        self.assertEqual(self.store.get("d"), {"n": 9})
        self.assertEqual(self.store.query({"where": [{"eq": ["by_n", 9]}]}), ["d"])
        with open(self.log_path(), "rb") as fh:
            self.assertEqual(fh.read(), b"")
        # reclamation runs during recovery
        self.assertNotIn(1, self.store.versions())
        # and the store keeps accepting patches
        self.store.apply("d", [{"op": "replace", "path": "/n", "value": 10}])
        self.assertEqual(self.store.get("d"), {"n": 10})

    def test_torn_tail_after_valid_unpublished_record(self):
        self.seed()
        self.faults.set("after_log_append")
        with self.assertRaises(InjectedFault):
            self.store.apply("d", [{"op": "replace", "path": "/n", "value": 5}])
        # a second, half-written record follows the valid one
        with open(self.log_path(), "a", encoding="utf-8") as fh:
            fh.write("999 {\"kind\": \"pat")
        self.reopen()
        self.assertEqual(self.store.get("d"), {"n": 5})
        self.assertEqual(self.store.latest, 2)


if __name__ == "__main__":
    unittest.main()

