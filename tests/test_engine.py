"""Acceptance and unit tests for the SI engine semantics."""

import unittest

from si import Engine, UnknownTransactionError, WriteConflictError


class ConflictTests(unittest.TestCase):
    def test_same_key_first_committer_wins(self):
        # (a) Two txns write the same key: first committer succeeds,
        # the second fails with WRITE_CONFLICT.
        eng = Engine()
        eng.begin("a")
        eng.begin("b")
        eng.write("a", "x", 1)
        eng.write("b", "x", 2)
        eng.commit("a")
        with self.assertRaises(WriteConflictError) as ctx:
            eng.commit("b")
        self.assertEqual(ctx.exception.conflicts, ["x"])
        # The failed txn produced no effect.
        self.assertEqual(eng.snapshot_state(), {"x": 1})

    def test_disjoint_write_sets_both_commit(self):
        # (b) Two txns writing disjoint key sets both succeed.
        eng = Engine()
        eng.begin("a")
        eng.begin("b")
        eng.write("a", "x", 1)
        eng.write("b", "y", 2)
        eng.commit("a")
        eng.commit("b")
        self.assertEqual(eng.snapshot_state(), {"x": 1, "y": 2})

    def test_write_skew_is_allowed(self):
        # (c) Write skew: A reads x and writes y, B reads y and writes x.
        # Under SI both commit; final state holds both writes.
        eng = Engine()
        eng.begin("seed")
        eng.write("seed", "x", 0)
        eng.write("seed", "y", 0)
        eng.commit("seed")

        eng.begin("a")
        eng.begin("b")
        self.assertEqual(eng.read("a", "x"), 0)
        self.assertEqual(eng.read("b", "y"), 0)
        eng.write("a", "y", 100)
        eng.write("b", "x", 200)
        eng.commit("a")
        eng.commit("b")  # disjoint write sets -> no conflict
        self.assertEqual(eng.snapshot_state(), {"x": 200, "y": 100})

    def test_retry_after_conflict_succeeds(self):
        # (d) A txn that failed with WRITE_CONFLICT can be retried safely.
        eng = Engine()
        eng.begin("a")
        eng.begin("b")
        eng.write("a", "x", 1)
        eng.write("b", "x", 2)
        eng.commit("a")
        with self.assertRaises(WriteConflictError):
            eng.commit("b")
        # Retry the same logical work as a fresh transaction.
        eng.begin("b2")
        self.assertEqual(eng.read("b2", "x"), 1)  # sees a's committed write
        eng.write("b2", "x", 2)
        eng.commit("b2")
        self.assertEqual(eng.snapshot_state(), {"x": 2})

    def test_conflict_detection_is_key_based_not_value_based(self):
        # Writing the *same value* to the same key still conflicts.
        eng = Engine()
        eng.begin("a")
        eng.begin("b")
        eng.write("a", "x", 7)
        eng.write("b", "x", 7)
        eng.commit("a")
        with self.assertRaises(WriteConflictError):
            eng.commit("b")


class SnapshotTests(unittest.TestCase):
    def test_reads_never_see_later_commits(self):
        eng = Engine()
        eng.begin("seed")
        eng.write("seed", "x", 1)
        eng.commit("seed")

        eng.begin("reader")
        eng.begin("writer")
        eng.write("writer", "x", 2)
        eng.commit("writer")
        # reader's snapshot predates writer's commit.
        self.assertEqual(eng.read("reader", "x"), 1)
        eng.abort("reader")

        eng.begin("late")
        self.assertEqual(eng.read("late", "x"), 2)

    def test_read_your_own_writes(self):
        eng = Engine()
        eng.begin("a")
        eng.write("a", "x", 5)
        self.assertEqual(eng.read("a", "x"), 5)
        eng.commit("a")

    def test_uncommitted_writes_are_invisible(self):
        eng = Engine()
        eng.begin("a")
        eng.begin("b")
        eng.write("a", "x", 9)
        self.assertIsNone(eng.read("b", "x"))
        eng.abort("a")
        eng.abort("b")

    def test_abort_discards_writes(self):
        eng = Engine()
        eng.begin("a")
        eng.write("a", "x", 1)
        eng.abort("a")
        self.assertEqual(eng.snapshot_state(), {})
        with self.assertRaises(UnknownTransactionError):
            eng.read("a", "x")

    def test_missing_key_reads_none(self):
        eng = Engine()
        eng.begin("a")
        self.assertIsNone(eng.read("a", "nope"))
        eng.abort("a")

    def test_empty_commit_succeeds(self):
        eng = Engine()
        eng.begin("a")
        ts = eng.commit("a")
        self.assertEqual(ts, 1)

    def test_unknown_txn_raises(self):
        eng = Engine()
        with self.assertRaises(UnknownTransactionError):
            eng.read("ghost", "x")
        with self.assertRaises(UnknownTransactionError):
            eng.commit("ghost")


if __name__ == "__main__":
    unittest.main()
