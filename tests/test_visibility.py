import unittest

from secidx import Store


def make_store():
    store = Store()
    store.create_index("by_email", "email", unique=True)
    store.create_index("by_age", "age", unique=False)
    return store


class VisibilityTest(unittest.TestCase):
    def setUp(self):
        self.store = make_store()

    def test_abort_erases_index_entries(self):
        # acceptance (b): after abort the txn's index entries are gone
        txn = self.store.begin()
        self.store.insert(txn, "u1", {"email": "a@x", "age": 30})
        self.store.abort(txn)
        self.assertEqual(self.store.find(None, "by_email", "a@x"), [])
        self.assertEqual(self.store.find(None, "by_age", 30), [])
        self.assertEqual(self.store.scan(None, "by_age"), [])
        self.assertEqual(self.store.rows, {})
        for idx in self.store.indexes.values():
            self.assertEqual(idx.map, {})

    def test_abort_after_update_and_delete_restores_state(self):
        t0 = self.store.begin()
        self.store.insert(t0, "u1", {"email": "a@x", "age": 30})
        self.store.commit(t0)
        t1 = self.store.begin()
        self.store.update(t1, "u1", {"email": "b@x", "age": 31})
        self.store.delete(t1, "u1")
        self.store.abort(t1)
        rows = self.store.find(None, "by_email", "a@x")
        self.assertEqual([r["pk"] for r in rows], ["u1"])
        self.assertEqual([r["pk"] for r in self.store.find(None, "by_age", 30)],
                         ["u1"])

    def test_uncommitted_invisible_to_other_txn(self):
        t1 = self.store.begin()
        self.store.insert(t1, "u1", {"email": "a@x", "age": 30})
        t2 = self.store.begin()
        # t2 cannot see t1's uncommitted insert
        self.assertEqual(self.store.find(t2, "by_email", "a@x"), [])
        self.assertEqual(self.store.scan(t2, "by_age"), [])
        # t1 sees its own write
        self.assertEqual(len(self.store.find(t1, "by_email", "a@x")), 1)
        self.store.commit(t1)
        # after commit t2 (read-committed) can see it
        self.assertEqual(len(self.store.find(t2, "by_email", "a@x")), 1)

    def test_uncommitted_delete_hides_row_only_for_self(self):
        t0 = self.store.begin()
        self.store.insert(t0, "u1", {"email": "a@x", "age": 30})
        self.store.commit(t0)
        t1 = self.store.begin()
        self.store.delete(t1, "u1")
        self.assertEqual(self.store.find(t1, "by_email", "a@x"), [])
        t2 = self.store.begin()
        self.assertEqual(len(self.store.find(t2, "by_email", "a@x")), 1)
        self.store.abort(t1)

    def test_uncommitted_update_visible_only_to_self(self):
        t0 = self.store.begin()
        self.store.insert(t0, "u1", {"email": "a@x", "age": 30})
        self.store.commit(t0)
        t1 = self.store.begin()
        self.store.update(t1, "u1", {"email": "new@x", "age": 31})
        # self: new key hits, old key misses
        self.assertEqual([r["pk"] for r in self.store.find(t1, "by_email", "new@x")],
                         ["u1"])
        self.assertEqual(self.store.find(t1, "by_email", "a@x"), [])
        # others: old key still hits, new key misses
        self.assertEqual([r["pk"] for r in self.store.find(None, "by_email", "a@x")],
                         ["u1"])
        self.assertEqual(self.store.find(None, "by_email", "new@x"), [])
        self.store.commit(t1)
        # after commit: moved for everyone
        self.assertEqual(self.store.find(None, "by_email", "a@x"), [])
        self.assertEqual([r["pk"] for r in self.store.find(None, "by_email", "new@x")],
                         ["u1"])


if __name__ == "__main__":
    unittest.main()
