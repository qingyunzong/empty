import copy
import unittest
from fractions import Fraction

from mvview import BatchError, Engine
from model import check_engine_vs_model


def snapshot(engine):
    return (
        copy.deepcopy(engine.left),
        copy.deepcopy(engine.right),
        copy.deepcopy(engine.left_by_cid),
        copy.deepcopy(engine.right_by_cid),
        copy.deepcopy(engine.outputs),
        engine.batch_id,
        engine.view(),
    )


def assert_unchanged(testcase, engine, snap):
    left, right, lbc, rbc, outputs, batch_id, view = snap
    testcase.assertEqual(engine.left, left)
    testcase.assertEqual(engine.right, right)
    testcase.assertEqual(engine.left_by_cid, lbc)
    testcase.assertEqual(engine.right_by_cid, rbc)
    testcase.assertEqual(engine.outputs, outputs)
    testcase.assertEqual(engine.batch_id, batch_id)
    testcase.assertEqual(engine.view(), view)
    check_engine_vs_model(testcase, engine)


class TestDeltaJoin(unittest.TestCase):
    def test_cross_term_same_batch_both_tables(self):
        # L and R change in the SAME batch: the dL x dR cross term must
        # contribute the new join row exactly once.
        e = Engine()
        e.apply_batch({
            "left_insert": [{"id": 1, "cid": "a", "value": 10}],
            "right_insert": [{"cid": "a", "group": "g1"}],
        })
        self.assertEqual(e.view()["g1"]["count"], 1)
        self.assertEqual(e.view()["g1"]["sum"], 10)
        check_engine_vs_model(self, e)

    def test_cross_term_insert_and_retract_same_batch(self):
        e = Engine()
        e.apply_batch({
            "left_insert": [{"id": 1, "cid": "a", "value": 4}],
            "right_insert": [{"cid": "a", "group": "g1"}],
        })
        # same-batch: retract the right row, insert a new left row for "a"
        e.apply_batch({
            "left_insert": [{"id": 2, "cid": "a", "value": 6}],
            "right_retract": [{"cid": "a", "group": "g1"}],
        })
        self.assertEqual(e.view(), {})
        check_engine_vs_model(self, e)

    def test_duplicate_right_rows_amplify_by_multiplicity(self):
        e = Engine()
        e.apply_batch({
            "left_insert": [{"id": 1, "cid": "a", "value": 5}],
            "right_insert": [{"cid": "a", "group": "g1", "count": 3}],
        })
        self.assertEqual(e.view()["g1"]["count"], 3)
        self.assertEqual(e.view()["g1"]["sum"], 15)
        self.assertEqual(e.view()["g1"]["median"], 5)
        e.apply_batch({"right_retract": [{"cid": "a", "group": "g1", "count": 2}]})
        self.assertEqual(e.view()["g1"]["count"], 1)
        check_engine_vs_model(self, e)

    def test_null_join_keys_never_match(self):
        e = Engine()
        e.apply_batch({
            "left_insert": [
                {"id": 1, "cid": None, "value": 100},
                {"id": 2, "cid": "a", "value": 7},
            ],
            "right_insert": [
                {"cid": None, "group": "gnull"},
                {"cid": "a", "group": "g1"},
            ],
        })
        self.assertNotIn("gnull", e.view())
        self.assertEqual(e.view()["g1"]["count"], 1)
        check_engine_vs_model(self, e)

    def test_replace_is_retract_plus_insert_in_one_batch(self):
        e = Engine()
        e.apply_batch({
            "left_insert": [{"id": 1, "cid": "a", "value": 3}],
            "right_insert": [{"cid": "a", "group": "g1"}, {"cid": "b", "group": "g1"}],
        })
        e.apply_batch({"left_replace": [{"id": 1, "cid": "b", "value": 8}]})
        self.assertEqual(e.view()["g1"]["count"], 1)
        self.assertEqual(e.view()["g1"]["sum"], 8)
        check_engine_vs_model(self, e)


class TestMigrationAndMedian(unittest.TestCase):
    def test_customer_group_migration(self):
        e = Engine()
        e.apply_batch({
            "left_insert": [
                {"id": 1, "cid": "a", "value": 10},
                {"id": 2, "cid": "b", "value": 20},
            ],
            "right_insert": [
                {"cid": "a", "group": "g1"},
                {"cid": "b", "group": "g1"},
            ],
        })
        e.apply_batch({"migrate": [{"cid": "a", "from": "g1", "to": "g2"}]})
        self.assertEqual(e.view()["g1"], {"count": 1, "sum": 20, "median": 20})
        self.assertEqual(e.view()["g2"], {"count": 1, "sum": 10, "median": 10})
        check_engine_vs_model(self, e)
        # migrate back
        e.apply_batch({"migrate": [{"cid": "a", "from": "g2", "to": "g1"}]})
        self.assertEqual(e.view()["g1"]["count"], 2)
        self.assertNotIn("g2", e.view())
        check_engine_vs_model(self, e)

    def test_median_odd_even_exact_rational(self):
        e = Engine()
        e.apply_batch({
            "left_insert": [{"id": i, "cid": "a", "value": v}
                            for i, v in enumerate([1, 2, 4], start=1)],
            "right_insert": [{"cid": "a", "group": "g"}],
        })
        self.assertEqual(e.median("g"), 2)  # odd: middle element
        e.apply_batch({"left_insert": [{"id": 4, "cid": "a", "value": 8}]})
        self.assertEqual(e.median("g"), 3)  # even: (2+4)/2
        e.apply_batch({"left_insert": [{"id": 5, "cid": "a", "value": "1/2"}]})
        self.assertEqual(e.median("g"), 2)  # odd again
        e.apply_batch({"left_insert": [{"id": 6, "cid": "a", "value": "1/3"}]})
        # sorted: 1/3, 1/2, 1, 2, 4, 8 -> median (1+2)/2 = 3/2
        self.assertEqual(e.median("g"), "3/2")
        e.apply_batch({"left_retract": [1, 2, 3, 4, 5, 6]})
        self.assertEqual(e.view(), {})
        check_engine_vs_model(self, e)

    def test_all_null_group(self):
        e = Engine()
        e.apply_batch({
            "left_insert": [
                {"id": 1, "cid": "a", "value": None},
                {"id": 2, "cid": "a", "value": None},
            ],
            "right_insert": [{"cid": "a", "group": "g"}],
        })
        # COUNT(*) still counts NULL-valued rows; SUM and MEDIAN are NULL
        self.assertEqual(e.view()["g"], {"count": 2, "sum": None, "median": None})
        e.apply_batch({"left_insert": [{"id": 3, "cid": "a", "value": 9}]})
        self.assertEqual(e.view()["g"], {"count": 3, "sum": 9, "median": 9})
        check_engine_vs_model(self, e)


class TestAtomicity(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()
        self.engine.apply_batch({
            "left_insert": [
                {"id": 1, "cid": "a", "value": 5},
                {"id": 2, "cid": "b", "value": 7},
            ],
            "right_insert": [
                {"cid": "a", "group": "g1"},
                {"cid": "b", "group": "g2", "count": 2},
            ],
        })

    def test_illegal_batches_roll_back_fully(self):
        illegal = [
            {"left_insert": [{"id": 1, "cid": "z", "value": 1}]},          # unique id conflict
            {"left_insert": [{"id": 9, "cid": "z"}, {"id": 9, "cid": "y"}]},  # dup in batch
            {"left_retract": [42]},                                          # out-of-range delete
            {"left_replace": [{"id": 42, "cid": "a", "value": 1}]},          # out-of-range replace
            {"right_retract": [{"cid": "a", "group": "g1", "count": 2}]},    # out-of-range delete
            {"right_retract": [{"cid": "nobody", "group": "g1"}]},           # missing right row
            {"migrate": [{"cid": "a", "from": "g2", "to": "g1"}]},           # wrong source group
            {"left_insert": [{"id": 3, "cid": "a", "value": 1}],
             "left_retract": [3]},                                           # conflicting ops
            {"left_insert": [{"id": 3, "cid": "a", "value": 1}],
             "right_retract": [{"cid": "b", "group": "g2", "count": 99}]},   # fails late
        ]
        for batch in illegal:
            snap = snapshot(self.engine)
            with self.assertRaises(BatchError, msg=f"batch should fail: {batch}"):
                self.engine.apply_batch(batch)
            assert_unchanged(self, self.engine, snap)

    def test_valid_batch_still_works_after_illegal_one(self):
        snap = snapshot(self.engine)
        with self.assertRaises(BatchError):
            self.engine.apply_batch({"left_retract": [999]})
        assert_unchanged(self, self.engine, snap)
        self.engine.apply_batch({"left_insert": [{"id": 3, "cid": "a", "value": 1}]})
        self.assertEqual(self.engine.view()["g1"]["count"], 2)
        self.assertEqual(len(self.engine.outputs), 2)  # only committed batches published
        check_engine_vs_model(self, self.engine)


if __name__ == "__main__":
    unittest.main()
