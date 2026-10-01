import bisect
import random
import unittest
from fractions import Fraction

from model import (apply_to_model, engine_view_tuples, reference_values,
                   reference_view)
from mvview import BatchError, Engine

CUSTOMERS = ["c0", "c1", "c2", "c3", "c4", None]  # at most 5 named customers
TXIDS = [f"t{i}" for i in range(12)]              # at most 12 transactions
GROUPS = ["A", "B", "C", None]


def gen_value(rng):
    roll = rng.random()
    if roll < 0.2:
        return None
    if roll < 0.85:
        return rng.randint(-20, 40)
    return {"num": rng.randint(-20, 40), "den": 2}


def gen_batch(rng, left, right):
    """Generate a legal batch; each op is chosen against the working copy."""
    work_left, work_right = dict(left), dict(right)
    ops = []
    for _ in range(rng.randint(1, 6)):
        kind = rng.choice(["insert_tx", "insert_tx", "insert_tx",
                           "insert_cust", "insert_cust", "insert_cust",
                           "retract_tx", "replace_tx",
                           "retract_cust", "migrate"])
        op = None
        if kind == "insert_tx":
            free = [t for t in TXIDS if t not in work_left]
            if free:
                op = {"op": "insert_tx", "txid": rng.choice(free),
                      "customer": rng.choice(CUSTOMERS),
                      "value": gen_value(rng)}
        elif kind == "retract_tx" and work_left:
            op = {"op": "retract_tx", "txid": rng.choice(list(work_left))}
        elif kind == "replace_tx" and work_left:
            op = {"op": "replace_tx", "txid": rng.choice(list(work_left)),
                  "customer": rng.choice(CUSTOMERS),
                  "value": gen_value(rng)}
        elif kind == "insert_cust":
            op = {"op": "insert_cust", "customer": rng.choice(CUSTOMERS),
                  "group": rng.choice(GROUPS),
                  "count": rng.randint(1, 2)}
        elif kind == "retract_cust" and work_right:
            key = rng.choice(list(work_right))
            op = {"op": "retract_cust", "customer": key[0],
                  "group": key[1],
                  "count": rng.randint(1, work_right[key])}
        elif kind == "migrate" and work_right:
            key = rng.choice(list(work_right))
            op = {"op": "migrate", "customer": key[0], "from": key[1],
                  "to": rng.choice(GROUPS),
                  "count": rng.randint(1, work_right[key])}
        if op is not None:
            ops.append(op)
            apply_to_model([op], work_left, work_right)
    if not ops:
        ops.append({"op": "insert_cust", "customer": rng.choice(CUSTOMERS),
                    "group": rng.choice(GROUPS), "count": 1})
    return ops


class RandomizedModelTest(unittest.TestCase):
    def test_batches_against_reference_model(self):
        rng = random.Random(20261001)
        eng = Engine()
        left, right = {}, {}
        for batch_no in range(300):
            ops = gen_batch(rng, left, right)
            eng.apply_batch(ops)
            apply_to_model(ops, left, right)
            self.assertEqual(eng.left, left, f"batch {batch_no}: {ops}")
            self.assertEqual(eng.right, right, f"batch {batch_no}: {ops}")
            self.assertEqual(engine_view_tuples(eng),
                             reference_view(left, right),
                             f"batch {batch_no}: {ops}")
            ref_vals = reference_values(left, right)
            for grp in eng.view():
                vals = ref_vals.get(grp, [])
                probe = Fraction(rng.randint(-25, 45))
                self.assertEqual(eng.rank(grp, probe),
                                 bisect.bisect_left(vals, probe),
                                 f"rank batch {batch_no}")
                if vals:
                    k = rng.randrange(len(vals))
                    self.assertEqual(eng.select(grp, k), vals[k],
                                     f"select batch {batch_no}")


class CrossTermTest(unittest.TestCase):
    def test_same_batch_insert_insert(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c", "group": "G"},
            {"op": "insert_tx", "txid": "t", "customer": "c", "value": 9},
        ])
        view = eng.view()
        self.assertEqual(view["G"]["count"], 1)
        self.assertEqual(view["G"]["sum"], Fraction(9))

    def test_same_batch_insert_retract(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c", "group": "G"},
            {"op": "insert_tx", "txid": "t1", "customer": "c", "value": 10},
        ])
        eng.apply_batch([
            {"op": "retract_cust", "customer": "c", "group": "G"},
            {"op": "insert_tx", "txid": "t2", "customer": "c", "value": 5},
        ])
        self.assertEqual(eng.view(), {})

    def test_same_batch_retract_retract(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c", "group": "G"},
            {"op": "insert_tx", "txid": "t1", "customer": "c", "value": 10},
        ])
        eng.apply_batch([
            {"op": "retract_tx", "txid": "t1"},
            {"op": "retract_cust", "customer": "c", "group": "G"},
        ])
        self.assertEqual(eng.view(), {})
        self.assertEqual(eng.left, {})
        self.assertEqual(eng.right, {})

    def test_same_batch_replace_and_migrate(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c", "group": "A"},
            {"op": "insert_cust", "customer": "c", "group": "B"},
            {"op": "insert_tx", "txid": "t1", "customer": "c", "value": 4},
        ])
        eng.apply_batch([
            {"op": "migrate", "customer": "c", "from": "A", "to": "B"},
            {"op": "replace_tx", "txid": "t1", "customer": "c", "value": 8},
        ])
        view = eng.view()
        self.assertNotIn("A", view)
        self.assertEqual(view["B"]["count"], 2)
        self.assertEqual(view["B"]["sum"], Fraction(16))


class MedianParityTest(unittest.TestCase):
    def test_odd_even_transitions(self):
        eng = Engine()
        eng.apply_batch([{"op": "insert_cust", "customer": "c", "group": "G"}])
        for idx, value in enumerate([3, 1, 2]):
            eng.apply_batch([{"op": "insert_tx", "txid": f"t{idx}",
                              "customer": "c", "value": value}])
        self.assertEqual(eng.view()["G"]["median"], Fraction(2))  # 1,2,3
        eng.apply_batch([{"op": "insert_tx", "txid": "t3",
                          "customer": "c", "value": 10}])
        self.assertEqual(eng.view()["G"]["median"],
                         Fraction(5, 2))  # 1,2,3,10
        eng.apply_batch([{"op": "retract_tx", "txid": "t3"}])
        self.assertEqual(eng.view()["G"]["median"], Fraction(2))
        eng.apply_batch([{"op": "retract_tx", "txid": "t0"}])
        self.assertEqual(eng.view()["G"]["median"],
                         Fraction(3, 2))  # 1,2

    def test_exact_rational_median(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c", "group": "G"},
            {"op": "insert_tx", "txid": "t0", "customer": "c",
             "value": {"num": 1, "den": 3}},
            {"op": "insert_tx", "txid": "t1", "customer": "c",
             "value": {"num": 1, "den": 2}},
        ])
        self.assertEqual(eng.view()["G"]["median"], Fraction(5, 12))
        self.assertEqual(eng.view()["G"]["sum"], Fraction(5, 6))


class NullHandlingTest(unittest.TestCase):
    def test_all_null_group(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c1", "group": "G"},
            {"op": "insert_tx", "txid": "t1", "customer": "c1", "value": None},
            {"op": "insert_tx", "txid": "t2", "customer": "c1", "value": None},
        ])
        stats = eng.view()["G"]
        self.assertEqual(stats["count"], 2)
        self.assertIsNone(stats["sum"])
        self.assertIsNone(stats["median"])

    def test_null_join_keys_never_match(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": None, "group": "G"},
            {"op": "insert_cust", "customer": "c1", "group": None},
            {"op": "insert_tx", "txid": "t1", "customer": None, "value": 5},
            {"op": "insert_tx", "txid": "t2", "customer": "c1", "value": 7},
        ])
        view = eng.view()
        self.assertNotIn("G", view)
        self.assertEqual(view[None]["count"], 1)
        self.assertEqual(view[None]["median"], Fraction(7))


class MultiplicityTest(unittest.TestCase):
    def test_duplicate_right_rows_amplify(self):
        eng = Engine()
        eng.apply_batch([
            {"op": "insert_cust", "customer": "c", "group": "G", "count": 2},
            {"op": "insert_tx", "txid": "t", "customer": "c", "value": 5},
        ])
        stats = eng.view()["G"]
        self.assertEqual(stats["count"], 2)
        self.assertEqual(stats["sum"], Fraction(10))
        self.assertEqual(stats["median"], Fraction(5))
        eng.apply_batch([{"op": "retract_cust", "customer": "c",
                          "group": "G", "count": 1}])
        stats = eng.view()["G"]
        self.assertEqual(stats["count"], 1)
        self.assertEqual(stats["sum"], Fraction(5))


class AtomicityTest(unittest.TestCase):
    def setUp(self):
        self.eng = Engine()
        self.eng.apply_batch([
            {"op": "insert_cust", "customer": "c1", "group": "A"},
            {"op": "insert_cust", "customer": "c2", "group": "B", "count": 2},
            {"op": "insert_tx", "txid": "t1", "customer": "c1", "value": 10},
            {"op": "insert_tx", "txid": "t2", "customer": "c2", "value": 20},
        ])
        self.left_before = dict(self.eng.left)
        self.right_before = dict(self.eng.right)
        self.cursor_before = self.eng.cursor()

    def _assert_fully_rolled_back(self):
        self.assertEqual(self.eng.left, self.left_before)
        self.assertEqual(self.eng.right, self.right_before)
        self.assertEqual(self.eng.cursor(), self.cursor_before)
        self.assertEqual(self.eng.version, self.cursor_before["version"])

    def test_retract_missing_txid_rolls_back(self):
        with self.assertRaises(BatchError):
            self.eng.apply_batch([
                {"op": "insert_tx", "txid": "t3", "customer": "c1",
                 "value": 1},
                {"op": "retract_tx", "txid": "no-such-tx"},
            ])
        self._assert_fully_rolled_back()

    def test_duplicate_txid_rolls_back(self):
        with self.assertRaises(BatchError):
            self.eng.apply_batch([
                {"op": "insert_cust", "customer": "c1", "group": "C"},
                {"op": "insert_tx", "txid": "t1", "customer": "c1",
                 "value": 99},
            ])
        self._assert_fully_rolled_back()

    def test_over_retract_right_rolls_back(self):
        with self.assertRaises(BatchError):
            self.eng.apply_batch([
                {"op": "retract_tx", "txid": "t1"},
                {"op": "retract_cust", "customer": "c1", "group": "A",
                 "count": 5},
            ])
        self._assert_fully_rolled_back()

    def test_failed_migrate_rolls_back(self):
        with self.assertRaises(BatchError):
            self.eng.apply_batch([
                {"op": "insert_tx", "txid": "t9", "customer": "c1",
                 "value": 3},
                {"op": "migrate", "customer": "c2", "from": "B", "to": "A",
                 "count": 7},
            ])
        self._assert_fully_rolled_back()

    def test_engine_usable_after_failed_batch(self):
        with self.assertRaises(BatchError):
            self.eng.apply_batch([{"op": "retract_tx", "txid": "nope"}])
        self.eng.apply_batch([
            {"op": "insert_tx", "txid": "t3", "customer": "c1", "value": 1},
        ])
        self.assertEqual(self.eng.view()["A"]["count"], 2)
        self.assertEqual(self.eng.view()["A"]["sum"], Fraction(11))


if __name__ == "__main__":
    unittest.main()
