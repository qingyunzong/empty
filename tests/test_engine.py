"""Scenario tests for the incremental bag relational algebra engine."""
import os
import tempfile
import unittest

from bagra import (
    Cmp,
    DuplicateSubscriptionError,
    Engine,
    NegativeMultiplicityError,
    UnknownSubscriptionError,
    distinct,
    evaluate,
    except_all,
    filter_,
    intersect_all,
    join,
    project,
    scan,
    union_all,
)


def accumulate(records):
    """Fold publish records into a {row: multiplicity} bag."""
    bag = {}
    for rec in records:
        row = tuple(rec["row"])
        bag[row] = bag.get(row, 0) + rec["delta"]
        if bag[row] == 0:
            del bag[row]
    return bag


class EngineTest(unittest.TestCase):
    def test_self_join_cross_terms(self):
        eng = Engine()
        plan = join(scan("T"), scan("T"), [0], [0])
        pubs = eng.add_subscription("s", plan)
        self.assertEqual(pubs, [])

        pubs = eng.apply_batch([("T", (1, "a"), 1)])
        self.assertEqual(accumulate(pubs), {(1, "a", 1, "a"): 1})

        # The new row pairs with the old row in both orders and with
        # itself: this is the dL x dR cross term of a self join.
        pubs = eng.apply_batch([("T", (1, "b"), 1)])
        self.assertEqual(accumulate(pubs), {
            (1, "a", 1, "b"): 1,
            (1, "b", 1, "a"): 1,
            (1, "b", 1, "b"): 1,
        })
        self.assertEqual(
            accumulate(eng.publish_log),
            evaluate(plan, eng.tables),
        )

    def test_same_batch_both_sides_delete(self):
        eng = Engine()
        plan = join(scan("R"), scan("S"), [0], [0])
        eng.add_subscription("s", plan)
        eng.apply_batch([("R", (0, "a"), 2), ("S", (0, "b"), 3)])
        self.assertEqual(accumulate(eng.publish_log),
                         {(0, "a", 0, "b"): 6})

        # Both sides shrink in one batch; the negative cross term must
        # remove exactly the product of the removed multiplicities.
        pubs = eng.apply_batch([("R", (0, "a"), -2), ("S", (0, "b"), -2)])
        self.assertEqual(accumulate(pubs), {(0, "a", 0, "b"): -6})
        self.assertEqual(accumulate(eng.publish_log), {})
        self.assertEqual(evaluate(plan, eng.tables), {})

    def test_projection_merges_duplicates(self):
        eng = Engine()
        plan = project(scan("T"), [0])
        eng.add_subscription("s", plan)
        pubs = eng.apply_batch([("T", (1, "a"), 1), ("T", (1, "b"), 1)])
        # Two distinct source rows collapse into one projected tuple.
        self.assertEqual(accumulate(pubs), {(1,): 2})

        pubs = eng.apply_batch([("T", (1, "a"), -1)])
        self.assertEqual(accumulate(pubs), {(1,): -1})
        self.assertEqual(accumulate(eng.publish_log), {(1,): 1})

    def test_distinct_vanish_and_reappear(self):
        eng = Engine()
        plan = distinct(scan("T"))
        eng.add_subscription("s", plan)

        self.assertEqual(accumulate(eng.apply_batch([("T", ("x",), 1)])),
                         {("x",): 1})
        # Second copy: no zero-threshold crossing, no output.
        self.assertEqual(eng.apply_batch([("T", ("x",), 1)]), [])
        # Removing one of two copies: still present, no output.
        self.assertEqual(eng.apply_batch([("T", ("x",), -1)]), [])
        # Removing the last copy: crosses to zero, emit deletion.
        self.assertEqual(accumulate(eng.apply_batch([("T", ("x",), -1)])),
                         {("x",): -1})
        # Reappears: crosses back above zero.
        self.assertEqual(accumulate(eng.apply_batch([("T", ("x",), 1)])),
                         {("x",): 1})

    def test_null_join_vs_set_identity(self):
        eng = Engine()
        jplan = join(scan("R"), scan("S"), [0], [0])
        dplan = distinct(scan("R"))
        eng.add_subscription("j", jplan)
        eng.add_subscription("d", dplan)

        # NULL keys never join, even with each other.
        pubs = eng.apply_batch([("R", (None, "x"), 1),
                                ("S", (None, "y"), 1)])
        join_pubs = [r for r in pubs if r["subscription"] == "j"]
        self.assertEqual(join_pubs, [])
        # ...but distinct treats NULL as an ordinary value: two NULL rows
        # are the same element and appear once.
        eng.apply_batch([("R", (None, "x"), 1)])
        distinct_pubs = [r for r in eng.publish_log
                         if r["subscription"] == "d"]
        self.assertEqual(accumulate(distinct_pubs), {(None, "x"): 1})

        # A non-NULL match does join.
        pubs = eng.apply_batch([("R", (7, "x"), 1), ("S", (7, "y"), 1)])
        join_pubs = [r for r in pubs if r["subscription"] == "j"]
        self.assertEqual(accumulate(join_pubs), {(7, "x", 7, "y"): 1})

    def test_shared_node_computed_once_per_batch(self):
        eng = Engine()
        shared = filter_(scan("T"), Cmp("ge", 0, 0))
        eng.add_subscription("a", distinct(shared))
        eng.add_subscription("b", project(shared, [0]))

        shared_node = eng._node_by_plan[shared]
        before = shared_node.compute_count
        eng.apply_batch([("T", (1, "z"), 1), ("T", (2, "y"), 1)])
        # One batch, two downstream readers, exactly one recomputation.
        self.assertEqual(shared_node.compute_count, before + 1)

        # Both downstreams observe the shared node's output.
        self.assertEqual(accumulate(
            [r for r in eng.publish_log if r["subscription"] == "a"]),
            {(1, "z"): 1, (2, "y"): 1})
        self.assertEqual(accumulate(
            [r for r in eng.publish_log if r["subscription"] == "b"]),
            {(1,): 1, (2,): 1})

    def test_error_batch_rolls_back(self):
        eng = Engine()
        plan = scan("T")
        eng.add_subscription("s", plan)
        eng.apply_batch([("T", (1,), 1)], batch_id=1)
        version = eng.version
        log_len = len(eng.publish_log)

        with self.assertRaises(NegativeMultiplicityError):
            eng.apply_batch([("T", (1,), -2), ("T", (2,), 1)], batch_id=2)

        # Nothing changed: no version bump, no publishes, no state.
        self.assertEqual(eng.version, version)
        self.assertEqual(len(eng.publish_log), log_len)
        self.assertEqual(eng.tables["T"], {(1,): 1})
        # The engine keeps working after the failed batch.
        pubs = eng.apply_batch([("T", (2,), 1)], batch_id=3)
        self.assertEqual(accumulate(pubs), {(2,): 1})

    def test_except_all_floors_at_zero(self):
        eng = Engine()
        plan = except_all(scan("L"), scan("R"))
        eng.add_subscription("s", plan)
        eng.apply_batch([("L", ("a",), 1), ("L", ("b",), 2)])
        # Right side heavier than left: result floors at zero, no error,
        # and no negative record is ever published.
        pubs = eng.apply_batch([("R", ("a",), 5), ("R", ("b",), 1)])
        self.assertEqual(accumulate(pubs), {("a",): -1, ("b",): -1})
        self.assertEqual(evaluate(plan, eng.tables), {("b",): 1})
        self.assertEqual(accumulate(eng.publish_log), {("b",): 1})

    def test_intersect_all_min_semantics(self):
        eng = Engine()
        plan = intersect_all(scan("L"), scan("R"))
        eng.add_subscription("s", plan)
        eng.apply_batch([("L", ("a",), 3), ("R", ("a",), 2),
                         ("R", ("b",), 1)])
        self.assertEqual(accumulate(eng.publish_log), {("a",): 2})
        # Shrinking the smaller side emits a deletion; growing the larger
        # side past the smaller emits nothing.
        self.assertEqual(eng.apply_batch([("L", ("a",), 2)]), [])
        self.assertEqual(accumulate(eng.apply_batch([("R", ("a",), -2)])),
                         {("a",): -2})

    def test_add_and_remove_subscription(self):
        eng = Engine()
        eng.apply_batch([("T", (1,), 1), ("T", (2,), 1)])
        # A late subscriber receives the full snapshot at the current
        # version, then only deltas.
        pubs = eng.add_subscription("late", scan("T"))
        self.assertEqual(accumulate(pubs), {(1,): 1, (2,): 1})
        self.assertTrue(all(r["version"] == 1 for r in pubs))

        eng.remove_subscription("late")
        pubs = eng.apply_batch([("T", (3,), 1)])
        self.assertEqual(pubs, [])
        with self.assertRaises(UnknownSubscriptionError):
            eng.remove_subscription("late")
        with self.assertRaises(DuplicateSubscriptionError):
            eng.add_subscription("x", scan("T"))
            eng.add_subscription("x", scan("T"))

    def test_recovery_and_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            eng = Engine()
            plan = distinct(project(scan("T"), [0]))
            eng.add_subscription("s", plan)
            eng.apply_batch([("T", (1, "a"), 2)], batch_id=1)
            eng.apply_batch([("T", (2, "b"), 1)], batch_id=2)
            eng.save(path)

            # Recover mid-stream and continue: identical behaviour.
            eng2 = Engine.load(path)
            self.assertEqual(eng2.version, eng.version)
            self.assertEqual(eng2.publish_log, eng.publish_log)
            pubs = eng2.apply_batch([("T", (1, "a"), -1)], batch_id=3)
            # multiplicity of (1,) drops 2 -> 1: no zero crossing.
            self.assertEqual(pubs, [])
            pubs = eng2.apply_batch([("T", (1, "a"), -1)], batch_id=4)
            self.assertEqual(accumulate(pubs), {(1,): -1})

            # Replaying already-committed batch ids is a no-op: no state
            # change and, crucially, no duplicate publishes.
            log_len = len(eng2.publish_log)
            self.assertEqual(
                eng2.apply_batch([("T", (1, "a"), -1)], batch_id=4), [])
            self.assertEqual(len(eng2.publish_log), log_len)
            self.assertEqual(eng2.tables["T"], {(2, "b"): 1})

            # A fresh engine running the same script reaches the same
            # publish log, proving recovery is transparent.
            eng3 = Engine()
            eng3.add_subscription("s", plan)
            for bid, changes in [
                (1, [("T", (1, "a"), 2)]),
                (2, [("T", (2, "b"), 1)]),
                (3, [("T", (1, "a"), -1)]),
                (4, [("T", (1, "a"), -1)]),
            ]:
                eng3.apply_batch(changes, batch_id=bid)
            self.assertEqual(eng2.publish_log, eng3.publish_log)

    def test_publish_records_have_version_and_order(self):
        eng = Engine()
        eng.add_subscription("s", scan("T"))
        pubs = eng.apply_batch([("T", (2,), 1), ("T", (1,), 1),
                                ("T", (None,), 1)])
        self.assertEqual([r["version"] for r in pubs], [1, 1, 1])
        self.assertEqual([r["seq"] for r in pubs], [0, 1, 2])
        # Deterministic order independent of insertion order.
        eng2 = Engine()
        eng2.add_subscription("s", scan("T"))
        pubs2 = eng2.apply_batch([("T", (None,), 1), ("T", (1,), 1),
                                  ("T", (2,), 1)])
        self.assertEqual([r["row"] for r in pubs],
                         [r["row"] for r in pubs2])


if __name__ == "__main__":
    unittest.main()
