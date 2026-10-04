"""Basic engine behaviour: transactions, steal, abort, persistence."""

import unittest

from helpers import TempDB, keys_on_distinct_pages, keys_on_same_page


class BasicOpsTest(unittest.TestCase):
    def test_put_get_delete_commit(self):
        with TempDB() as db:
            eng = db.open()
            t = eng.begin()
            eng.put(t, "a", "1")
            self.assertEqual(eng.get(t, "a"), "1")
            eng.delete(t, "a")
            self.assertIsNone(eng.get(t, "a"))
            eng.put(t, "a", "2")
            eng.commit(t)
            self.assertEqual(eng.dump(), {"a": "2"})

    def test_commit_is_durable_across_reopen(self):
        with TempDB() as db:
            eng = db.open()
            t = eng.begin()
            eng.put(t, "x", "42")
            eng.commit(t)
            del eng  # simulate shutdown/crash of the process
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {"x": "42"})

    def test_uncommitted_data_is_rolled_back_after_crash(self):
        with TempDB() as db:
            eng = db.open()
            t = eng.begin()
            eng.put(t, "a", "committed")
            eng.commit(t)
            t2 = eng.begin()
            eng.put(t2, "a", "dirty")
            eng.put(t2, "b", "dirty")
            del eng  # crash before commit
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {"a": "committed"})

    def test_abort_rolls_back(self):
        with TempDB() as db:
            eng = db.open()
            t = eng.begin()
            eng.put(t, "a", "1")
            eng.commit(t)
            t2 = eng.begin()
            eng.put(t2, "a", "2")
            eng.delete(t2, "a")
            eng.put(t2, "b", "3")
            eng.abort(t2)
            self.assertEqual(eng.dump(), {"a": "1"})


class SamePageTest(unittest.TestCase):
    def test_two_txns_same_page_one_commits_one_aborts(self):
        with TempDB(num_pages=8) as db:
            ka, kb = keys_on_same_page(8)
            eng = db.open()
            t1 = eng.begin()
            eng.put(t1, ka, "t1")
            t2 = eng.begin()
            eng.put(t2, kb, "t2")
            eng.commit(t1)
            eng.abort(t2)  # undo must restore only kb's before-image
            self.assertEqual(eng.dump(), {ka: "t1"})
            del eng
            eng2 = db.open()  # recovery must agree
            self.assertEqual(eng2.dump(), {ka: "t1"})

    def test_two_txns_same_page_commit_and_crash_undo(self):
        with TempDB(num_pages=8) as db:
            ka, kb = keys_on_same_page(8)
            eng = db.open()
            t1 = eng.begin()
            eng.put(t1, ka, "t1")
            t2 = eng.begin()
            eng.put(t2, kb, "t2")
            eng.commit(t1)
            del eng  # crash: t2 is a loser, t1 a winner
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {ka: "t1"})
            undos = [e for e in eng2.trace if e["phase"] == "undo"
                     and e["action"] == "clr"]
            self.assertEqual(len(undos), 1)


class StealTest(unittest.TestCase):
    def test_dirty_page_written_before_commit_then_crash(self):
        # pool of 1 forces eviction (steal) of uncommitted dirty pages
        with TempDB(num_pages=8, pool_capacity=1) as db:
            k1, k2 = keys_on_distinct_pages(8)
            eng = db.open()
            t0 = eng.begin()
            eng.put(t0, "base", "ok")
            eng.commit(t0)
            t1 = eng.begin()
            eng.put(t1, k1, "v1")
            eng.put(t1, k2, "v2")  # steals k1's dirty page pre-commit
            steals = [e for e in eng.trace if e["action"] == "page_write"]
            self.assertTrue(steals, "expected a dirty page to be stolen")
            del eng  # crash with t1 uncommitted
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {"base": "ok"})


if __name__ == "__main__":
    unittest.main()
