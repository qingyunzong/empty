import unittest

from deptx import (
    DependencyCycleError,
    Engine,
    NoTransactionError,
    UnknownSavepointError,
)


class TestNestedRollback(unittest.TestCase):
    """Acceptance A: rolling back one of three layers affects only that layer."""

    def test_three_layer_rollback_only_current(self):
        eng = Engine()
        eng.begin()
        eng.set("x", "1")
        eng.begin()
        eng.set("x", "2")
        eng.begin()
        eng.set("x", "3")
        self.assertEqual(eng.get("x"), "3")

        eng.rollback()  # drop layer 3 only
        self.assertEqual(eng.get("x"), "2")
        self.assertEqual(eng.depth, 2)

        eng.rollback()  # drop layer 2 only
        self.assertEqual(eng.get("x"), "1")
        self.assertEqual(eng.depth, 1)

        eng.rollback()  # drop layer 1; nothing was ever committed
        self.assertIsNone(eng.get("x"))
        self.assertEqual(eng.depth, 0)

    def test_rollback_discards_changes_committed_by_inner_layer(self):
        eng = Engine()
        eng.begin()
        eng.set("k", "outer")
        eng.begin()
        eng.set("k", "inner")
        eng.commit()  # inner merges into outer
        self.assertEqual(eng.get("k"), "inner")
        eng.rollback()  # outer rollback must not keep inner-committed value
        self.assertIsNone(eng.get("k"))

    def test_inner_commit_visible_in_outer_but_not_base(self):
        eng = Engine()
        eng.begin()
        eng.begin()
        eng.set("k", "v")
        eng.commit()
        self.assertEqual(eng.get("k"), "v")  # visible in outer layer view
        eng.commit()
        self.assertEqual(eng.get("k"), "v")  # now committed to base


class TestSavepoints(unittest.TestCase):
    """Acceptance B: undo to a savepoint removes dependencies added after it."""

    def test_undo_removes_dependencies_added_after_savepoint(self):
        eng = Engine()
        eng.begin()
        eng.depend("a", "b")
        eng.savepoint("s")
        eng.depend("b", "c")
        eng.depend("c", "d")
        # with b->c and c->d present, d->b would close a cycle
        with self.assertRaises(DependencyCycleError):
            eng.depend("d", "b")

        eng.undo("s")
        # dependencies added after s are gone, so these now succeed
        eng.depend("d", "b")
        eng.depend("d", "c")
        # pre-savepoint dependency a->b survived the undo
        with self.assertRaises(DependencyCycleError):
            eng.depend("b", "a")

    def test_undo_keeps_changes_before_savepoint(self):
        eng = Engine()
        eng.begin()
        eng.set("k", "before")
        eng.savepoint("s")
        eng.set("k", "after")
        eng.set("extra", "x")
        eng.undo("s")
        self.assertEqual(eng.get("k"), "before")
        self.assertIsNone(eng.get("extra"))

    def test_savepoint_scoped_to_layer(self):
        eng = Engine()
        eng.begin()
        eng.savepoint("outer_sp")
        eng.begin()
        # savepoint from the outer layer does not exist here -> exit 10
        with self.assertRaises(UnknownSavepointError) as ctx:
            eng.undo("outer_sp")
        self.assertEqual(ctx.exception.exit_code, 10)
        eng.savepoint("inner_sp")
        eng.commit()
        # inner savepoints die with their layer on commit
        with self.assertRaises(UnknownSavepointError):
            eng.undo("inner_sp")
        # outer savepoint is usable again in its own layer
        eng.undo("outer_sp")

    def test_unknown_savepoint_exit_code(self):
        eng = Engine()
        eng.begin()
        with self.assertRaises(UnknownSavepointError) as ctx:
            eng.undo("nope")
        self.assertEqual(ctx.exception.exit_code, 10)

    def test_undo_to_same_savepoint_twice(self):
        eng = Engine()
        eng.begin()
        eng.savepoint("s")
        eng.set("k", "1")
        eng.undo("s")
        eng.set("k", "2")
        eng.undo("s")
        self.assertIsNone(eng.get("k"))


class TestDependencyCycles(unittest.TestCase):
    """Acceptance C: a failed depend leaves the transaction fully usable."""

    def test_cycle_failure_preserves_transaction(self):
        eng = Engine()
        eng.begin()
        eng.set("k", "v")
        eng.depend("a", "b")
        eng.depend("b", "c")
        with self.assertRaises(DependencyCycleError) as ctx:
            eng.depend("c", "a")
        self.assertEqual(ctx.exception.exit_code, 3)
        # layer is still alive and consistent
        self.assertEqual(eng.depth, 1)
        self.assertEqual(eng.get("k"), "v")
        eng.set("k2", "v2")
        eng.depend("c", "d")  # non-cyclic edge still accepted
        eng.commit()
        self.assertEqual(eng.get("k"), "v")
        self.assertEqual(eng.get("k2"), "v2")

    def test_self_loop_is_a_cycle(self):
        eng = Engine()
        eng.begin()
        with self.assertRaises(DependencyCycleError):
            eng.depend("a", "a")

    def test_cycle_detection_sees_edges_from_outer_layers(self):
        eng = Engine()
        eng.begin()
        eng.depend("a", "b")
        eng.begin()
        with self.assertRaises(DependencyCycleError):
            eng.depend("b", "a")
        eng.rollback()  # inner layer gone; outer edge remains
        with self.assertRaises(DependencyCycleError):
            eng.depend("b", "a")


class TestNoTransaction(unittest.TestCase):
    def test_commands_requiring_transaction_exit_11(self):
        for op in (
            lambda e: e.set("k", "v"),
            lambda e: e.depend("a", "b"),
            lambda e: e.commit(),
            lambda e: e.rollback(),
            lambda e: e.savepoint("s"),
            lambda e: e.undo("s"),
        ):
            eng = Engine()
            with self.assertRaises(NoTransactionError) as ctx:
                op(eng)
            self.assertEqual(ctx.exception.exit_code, 11)

    def test_get_without_transaction_reads_committed_base(self):
        eng = Engine()
        self.assertIsNone(eng.get("k"))
        eng.begin()
        eng.set("k", "v")
        eng.commit()
        self.assertEqual(eng.get("k"), "v")

    def test_uncommitted_outer_layer_not_visible_after_rollback(self):
        eng = Engine()
        eng.begin()
        eng.set("k", "uncommitted")
        eng.rollback()
        self.assertIsNone(eng.get("k"))


if __name__ == "__main__":
    unittest.main()
