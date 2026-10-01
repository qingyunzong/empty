import unittest

from secidx import Store, PkExists, PkNotFound, NoSuchIndex


def make_store():
    store = Store()
    store.create_index("by_email", "email", unique=True)
    store.create_index("by_age", "age", unique=False)
    return store


def committed_insert(store, pk, fields):
    txn = store.begin()
    store.insert(txn, pk, fields)
    store.commit(txn)


class BasicCrudTest(unittest.TestCase):
    def setUp(self):
        self.store = make_store()

    def test_insert_find_commit(self):
        txn = self.store.begin()
        self.store.insert(txn, "u1", {"email": "a@x", "age": 30})
        self.store.commit(txn)
        rows = self.store.find(None, "by_email", "a@x")
        self.assertEqual(rows, [{"pk": "u1", "fields": {"email": "a@x", "age": 30}}])

    def test_uncommitted_insert_not_visible_to_others(self):
        txn = self.store.begin()
        self.store.insert(txn, "u1", {"email": "a@x", "age": 30})
        # other (no txn) readers see nothing
        self.assertEqual(self.store.find(None, "by_email", "a@x"), [])
        # own writes visible to self
        self.assertEqual(len(self.store.find(txn, "by_email", "a@x")), 1)

    def test_empty_find_returns_empty_list(self):
        # acceptance (d): empty result is [], not an error
        self.assertEqual(self.store.find(None, "by_email", "nobody@x"), [])
        self.assertEqual(self.store.scan(None, "by_age", 1, 99), [])

    def test_scan_range_and_order(self):
        committed_insert(self.store, "u1", {"email": "a@x", "age": 30})
        committed_insert(self.store, "u2", {"email": "b@x", "age": 25})
        committed_insert(self.store, "u3", {"email": "c@x", "age": 41})
        rows = self.store.scan(None, "by_age", 26, 50)
        self.assertEqual([r["pk"] for r in rows], ["u1", "u3"])
        rows = self.store.scan(None, "by_age")
        self.assertEqual([r["pk"] for r in rows], ["u2", "u1", "u3"])

    def test_non_unique_index_multi_match(self):
        committed_insert(self.store, "u1", {"email": "a@x", "age": 30})
        committed_insert(self.store, "u2", {"email": "b@x", "age": 30})
        rows = self.store.find(None, "by_age", 30)
        self.assertEqual([r["pk"] for r in rows], ["u1", "u2"])

    def test_update_moves_index_key(self):
        # acceptance (c): after update, old key misses, new key hits
        committed_insert(self.store, "u1", {"email": "a@x", "age": 30})
        txn = self.store.begin()
        self.store.update(txn, "u1", {"email": "new@x", "age": 31})
        self.store.commit(txn)
        self.assertEqual(self.store.find(None, "by_email", "a@x"), [])
        rows = self.store.find(None, "by_email", "new@x")
        self.assertEqual([r["pk"] for r in rows], ["u1"])
        self.assertEqual(self.store.find(None, "by_age", 30), [])
        self.assertEqual([r["pk"] for r in self.store.find(None, "by_age", 31)],
                         ["u1"])

    def test_delete_removes_index_entries(self):
        committed_insert(self.store, "u1", {"email": "a@x", "age": 30})
        txn = self.store.begin()
        self.store.delete(txn, "u1")
        self.store.commit(txn)
        self.assertEqual(self.store.find(None, "by_email", "a@x"), [])
        self.assertEqual(self.store.find(None, "by_age", 30), [])
        self.assertEqual(self.store.scan(None, "by_age"), [])

    def test_index_has_no_dangling_or_missing_entries(self):
        # invariant: index contents == full rescan of committed rows
        committed_insert(self.store, "u1", {"email": "a@x", "age": 30})
        committed_insert(self.store, "u2", {"email": "b@x", "age": 25})
        txn = self.store.begin()
        self.store.update(txn, "u1", {"email": "z@x", "age": 99})
        self.store.delete(txn, "u2")
        self.store.commit(txn)
        for name, idx in self.store.indexes.items():
            rebuilt = {}
            for pk, fields in self.store.rows.items():
                key = idx.key_of(fields)
                if key is not None:
                    rebuilt.setdefault(key, set()).add(pk)
            self.assertEqual(idx.map, rebuilt, "index %s diverged" % name)

    def test_duplicate_pk_rejected(self):
        committed_insert(self.store, "u1", {"email": "a@x"})
        txn = self.store.begin()
        with self.assertRaises(PkExists):
            self.store.insert(txn, "u1", {"email": "other@x"})
        # non-fatal: txn still usable
        self.store.insert(txn, "u2", {"email": "b@x"})
        self.store.commit(txn)
        self.assertEqual(len(self.store.find(None, "by_email", "b@x")), 1)

    def test_update_delete_missing_pk(self):
        txn = self.store.begin()
        with self.assertRaises(PkNotFound):
            self.store.update(txn, "nope", {"email": "a@x"})
        with self.assertRaises(PkNotFound):
            self.store.delete(txn, "nope")

    def test_find_unknown_index(self):
        with self.assertRaises(NoSuchIndex):
            self.store.find(None, "nope", "x")

    def test_null_field_not_indexed(self):
        committed_insert(self.store, "u1", {"email": None, "age": 30})
        committed_insert(self.store, "u2", {"age": 30})  # field absent
        # null/absent keys are unindexed: no unique conflict, no find hit
        self.assertEqual(self.store.find(None, "by_email", None), [])
        self.assertEqual([r["pk"] for r in self.store.find(None, "by_age", 30)],
                         ["u1", "u2"])


if __name__ == "__main__":
    unittest.main()
