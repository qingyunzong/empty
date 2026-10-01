import unittest

from si import Engine, WriteConflict


class TestSnapshotIsolation(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()

    def test_a_first_committer_wins_on_same_key(self):
        # (a) Two txns write the same key: first committer succeeds,
        # second fails with WRITE_CONFLICT.
        self.engine.begin("t1")
        self.engine.begin("t2")
        self.engine.write("t1", "x", 1)
        self.engine.write("t2", "x", 2)
        self.engine.commit("t1")
        with self.assertRaises(WriteConflict):
            self.engine.commit("t2")
        # Failed commit has no effect.
        self.assertEqual(self.engine.snapshot_state(), {"x": 1})

    def test_b_disjoint_write_sets_both_commit(self):
        # (b) Two txns writing disjoint key sets both succeed.
        self.engine.begin("t1")
        self.engine.begin("t2")
        self.engine.write("t1", "x", 1)
        self.engine.write("t2", "y", 2)
        self.engine.commit("t1")
        self.engine.commit("t2")
        self.assertEqual(self.engine.snapshot_state(), {"x": 1, "y": 2})

    def test_c_write_skew_is_allowed(self):
        # (c) Write skew: A reads x writes y, B reads y writes x.
        # Under SI this is allowed; both commits succeed.
        self.engine.begin("seed")
        self.engine.write("seed", "x", 100)
        self.engine.write("seed", "y", 100)
        self.engine.commit("seed")

        self.engine.begin("A")
        self.engine.begin("B")
        self.assertEqual(self.engine.read("A", "x"), 100)
        self.assertEqual(self.engine.read("B", "y"), 100)
        self.engine.write("A", "y", 0)
        self.engine.write("B", "x", 0)
        self.engine.commit("A")
        self.engine.commit("B")  # must NOT raise under SI
        self.assertEqual(self.engine.snapshot_state(), {"x": 0, "y": 0})

    def test_d_failed_txn_retries_successfully(self):
        # (d) A txn that fails with WRITE_CONFLICT can abort and retry
        # the same key successfully.
        self.engine.begin("t1")
        self.engine.begin("t2")
        self.engine.write("t1", "x", 1)
        self.engine.write("t2", "x", 2)
        self.engine.commit("t1")
        with self.assertRaises(WriteConflict):
            self.engine.commit("t2")

        self.engine.begin("t2-retry")
        self.assertEqual(self.engine.read("t2-retry", "x"), 1)
        self.engine.write("t2-retry", "x", 2)
        self.engine.commit("t2-retry")
        self.assertEqual(self.engine.snapshot_state(), {"x": 2})

    def test_snapshot_reads_never_see_later_commits(self):
        self.engine.begin("seed")
        self.engine.write("seed", "x", 1)
        self.engine.commit("seed")

        self.engine.begin("reader")
        self.engine.begin("writer")
        self.engine.write("writer", "x", 2)
        self.engine.commit("writer")
        # Reader's snapshot predates writer's commit.
        self.assertEqual(self.engine.read("reader", "x"), 1)
        self.engine.commit("reader")

    def test_read_own_writes(self):
        self.engine.begin("t1")
        self.engine.write("t1", "k", "v")
        self.assertEqual(self.engine.read("t1", "k"), "v")
        self.engine.abort("t1")
        self.assertEqual(self.engine.snapshot_state(), {})

    def test_read_missing_key_returns_none(self):
        self.engine.begin("t1")
        self.assertIsNone(self.engine.read("t1", "nope"))
        self.engine.abort("t1")

    def test_conflict_detection_is_key_based_not_value_based(self):
        # Same value written by both txns still conflicts.
        self.engine.begin("t1")
        self.engine.begin("t2")
        self.engine.write("t1", "x", 1)
        self.engine.write("t2", "x", 1)
        self.engine.commit("t1")
        with self.assertRaises(WriteConflict):
            self.engine.commit("t2")

    def test_read_only_txn_never_conflicts(self):
        self.engine.begin("t1")
        self.engine.begin("t2")
        self.engine.read("t1", "x")
        self.engine.write("t2", "x", 1)
        self.engine.commit("t2")
        self.engine.commit("t1")  # read-only: no write set, no conflict


if __name__ == "__main__":
    unittest.main()
