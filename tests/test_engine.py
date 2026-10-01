import unittest

from bagra import BagraError, Engine, evaluate


def as_map(result_list):
    return {tuple(row): count for row, count in result_list}


class EngineTestCase(unittest.TestCase):
    def make_engine(self, tables, nodes):
        eng = Engine()
        for name in tables:
            eng.add_table(name)
        for spec in nodes:
            eng.add_node(spec)
        return eng

    def assert_node_matches_interpreter(self, eng, node_id):
        nodes = {spec["id"]: spec for spec in eng._node_specs}
        expected = evaluate(node_id, nodes, eng.tables)
        self.assertEqual(expected, dict(eng.nodes[node_id].state))


class SelfJoinTest(EngineTestCase):
    def test_self_join_with_simultaneous_delta(self):
        eng = self.make_engine(
            ["R"],
            [
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "j", "type": "join", "inputs": ["r", "r"],
                 "left_keys": [0], "right_keys": [0]},
            ],
        )
        eng.subscribe("j")
        eng.apply_batch({"R": [((1, "a"), 1), ((1, "b"), 1), ((2, "c"), 1)]})
        # key 1: 2x2 = 4 rows, key 2: 1 row
        self.assertEqual(
            as_map(eng.result("j")),
            {
                (1, "a", 1, "a"): 1, (1, "a", 1, "b"): 1,
                (1, "b", 1, "a"): 1, (1, "b", 1, "b"): 1,
                (2, "c", 2, "c"): 1,
            },
        )
        self.assert_node_matches_interpreter(eng, "j")
        # one batch mutating the single side of a self-join: cross term needed
        eng.apply_batch({"R": [((1, "a"), -1), ((1, "d"), 1)]})
        self.assertEqual(
            as_map(eng.result("j")),
            {
                (1, "b", 1, "b"): 1, (1, "b", 1, "d"): 1,
                (1, "d", 1, "b"): 1, (1, "d", 1, "d"): 1,
                (2, "c", 2, "c"): 1,
            },
        )
        self.assert_node_matches_interpreter(eng, "j")


class JoinCrossTermTest(EngineTestCase):
    def test_same_batch_both_sides_delete(self):
        eng = self.make_engine(
            ["L", "R"],
            [
                {"id": "l", "type": "scan", "table": "L"},
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "j", "type": "join", "inputs": ["l", "r"],
                 "left_keys": [0], "right_keys": [0]},
            ],
        )
        eng.subscribe("j")
        eng.apply_batch({"L": [((1, "a"), 1)], "R": [((1, "x"), 1), ((1, "y"), 1)]})
        self.assertEqual(
            as_map(eng.result("j")),
            {(1, "a", 1, "x"): 1, (1, "a", 1, "y"): 1},
        )
        # delete from both sides in a single batch
        records = eng.apply_batch({"L": [((1, "a"), -1)], "R": [((1, "x"), -1)]})
        self.assertEqual(as_map(eng.result("j")), {})
        published = {(tuple(row), c) for rec in records for row, c in rec["changes"]}
        self.assertEqual(published, {((1, "a", 1, "x"), -1), ((1, "a", 1, "y"), -1)})
        self.assert_node_matches_interpreter(eng, "j")

    def test_same_batch_both_sides_insert(self):
        eng = self.make_engine(
            ["L", "R"],
            [
                {"id": "l", "type": "scan", "table": "L"},
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "j", "type": "join", "inputs": ["l", "r"],
                 "left_keys": [0], "right_keys": [0]},
            ],
        )
        eng.apply_batch({"L": [((1, "a"), 1)], "R": [((1, "x"), 2)]})
        # simultaneous insert on both sides: dL x dR cross term must appear
        eng.apply_batch({"L": [((1, "b"), 1)], "R": [((1, "y"), 1)]})
        self.assertEqual(
            as_map(eng.result("j")),
            {
                (1, "a", 1, "x"): 2, (1, "a", 1, "y"): 1,
                (1, "b", 1, "x"): 2, (1, "b", 1, "y"): 1,
            },
        )
        self.assert_node_matches_interpreter(eng, "j")


class ProjectTest(EngineTestCase):
    def test_projection_merges_duplicates(self):
        eng = self.make_engine(
            ["R"],
            [
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "p", "type": "project", "inputs": ["r"], "columns": [0]},
            ],
        )
        eng.subscribe("p")
        eng.apply_batch({"R": [((1, "a"), 1), ((1, "b"), 1)]})
        self.assertEqual(as_map(eng.result("p")), {(1,): 2})
        records = eng.apply_batch({"R": [((1, "a"), -1)]})
        self.assertEqual(as_map(eng.result("p")), {(1,): 1})
        # exactly one change record: multiplicity of (1,) drops 2 -> 1
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["changes"], [[[1], -1]])
        self.assert_node_matches_interpreter(eng, "p")


class DistinctTest(EngineTestCase):
    def test_distinct_disappear_then_reappear(self):
        eng = self.make_engine(
            ["R"],
            [
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "d", "type": "distinct", "inputs": ["r"]},
            ],
        )
        eng.subscribe("d")
        rec1 = eng.apply_batch({"R": [((5,), 1)]})
        self.assertEqual([c for rec in rec1 for c in rec["changes"]], [[[5], 1]])
        # second copy: no threshold crossing, nothing published
        rec2 = eng.apply_batch({"R": [((5,), 1)]})
        self.assertEqual(rec2, [])
        self.assertEqual(as_map(eng.result("d")), {(5,): 1})
        # remove one copy: still present, nothing published
        rec3 = eng.apply_batch({"R": [((5,), -1)]})
        self.assertEqual(rec3, [])
        # remove last copy: disappears
        rec4 = eng.apply_batch({"R": [((5,), -1)]})
        self.assertEqual([c for rec in rec4 for c in rec["changes"]], [[[5], -1]])
        self.assertEqual(as_map(eng.result("d")), {})
        # reappears
        rec5 = eng.apply_batch({"R": [((5,), 2)]})
        self.assertEqual([c for rec in rec5 for c in rec["changes"]], [[[5], 1]])
        self.assertEqual(as_map(eng.result("d")), {(5,): 1})
        self.assert_node_matches_interpreter(eng, "d")


class NullSemanticsTest(EngineTestCase):
    def test_null_join_never_matches_but_set_ops_use_identity(self):
        eng = self.make_engine(
            ["L", "R"],
            [
                {"id": "l", "type": "scan", "table": "L"},
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "j", "type": "join", "inputs": ["l", "r"],
                 "left_keys": [0], "right_keys": [0]},
                {"id": "i", "type": "intersect_all", "inputs": ["l", "r"]},
                {"id": "e", "type": "except_all", "inputs": ["l", "r"]},
                {"id": "d", "type": "distinct", "inputs": ["l"]},
            ],
        )
        eng.apply_batch({"L": [((None,), 2), ((1,), 1)], "R": [((None,), 1), ((1,), 1)]})
        # NULL does not join with NULL
        self.assertEqual(as_map(eng.result("j")), {(1, 1): 1})
        # set identity: NULL is a value for intersect/except/distinct
        self.assertEqual(as_map(eng.result("i")), {(None,): 1, (1,): 1})
        self.assertEqual(as_map(eng.result("e")), {(None,): 1})
        self.assertEqual(as_map(eng.result("d")), {(None,): 1, (1,): 1})
        for nid in ("j", "i", "e", "d"):
            self.assert_node_matches_interpreter(eng, nid)

    def test_null_filter_predicates(self):
        eng = self.make_engine(
            ["R"],
            [
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "f", "type": "filter", "inputs": ["r"],
                 "predicate": {"op": "gt", "col": 0, "value": 0}},
                {"id": "n", "type": "filter", "inputs": ["r"],
                 "predicate": {"op": "is_null", "col": 0}},
            ],
        )
        eng.apply_batch({"R": [((None,), 1), ((1,), 1), ((-1,), 1)]})
        self.assertEqual(as_map(eng.result("f")), {(1,): 1})
        self.assertEqual(as_map(eng.result("n")), {(None,): 1})


class SharedNodeTest(EngineTestCase):
    def test_shared_subexpression_updated_once_per_batch(self):
        eng = self.make_engine(
            ["R"],
            [
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "x", "type": "filter", "inputs": ["r"],
                 "predicate": {"op": "gt", "col": 0, "value": 0}},
                {"id": "y", "type": "project", "inputs": ["x"], "columns": [1]},
                {"id": "z", "type": "distinct", "inputs": ["x"]},
            ],
        )
        eng.subscribe("y")
        eng.subscribe("z")
        eng.apply_batch({"R": [((1, "a"), 1), ((-1, "b"), 1), ((1, "a"), 1), ((2, "c"), 1)]})
        # shared node x applied exactly once for the batch
        self.assertEqual(eng.stats["node_apply"]["x"], 1)
        self.assertEqual(as_map(eng.result("y")), {("a",): 2, ("c",): 1})
        self.assertEqual(as_map(eng.result("z")), {(1, "a"): 1, (2, "c"): 1})
        eng.apply_batch({"R": [((1, "a"), -1)]})
        self.assertEqual(eng.stats["node_apply"]["x"], 2)
        self.assertEqual(as_map(eng.result("y")), {("a",): 1, ("c",): 1})
        self.assert_node_matches_interpreter(eng, "y")
        self.assert_node_matches_interpreter(eng, "z")


class ErrorRollbackTest(EngineTestCase):
    def test_error_batch_rolls_back_whole_graph(self):
        eng = self.make_engine(
            ["L", "R"],
            [
                {"id": "l", "type": "scan", "table": "L"},
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "j", "type": "join", "inputs": ["l", "r"],
                 "left_keys": [0], "right_keys": [0]},
            ],
        )
        eng.subscribe("j")
        eng.apply_batch({"L": [((1, "a"), 1)], "R": [((1, "x"), 1)]})
        version_before = eng.version
        log_before = list(eng.publish_log)
        # second table edit is invalid; first table was already mutated
        with self.assertRaises(BagraError):
            eng.apply_batch({"L": [((2, "b"), 1)], "R": [((9, "q"), -1)]})
        self.assertEqual(eng.version, version_before)
        self.assertEqual(eng.publish_log, log_before)
        self.assertEqual(as_map(eng.table("L")), {(1, "a"): 1})
        self.assertEqual(as_map(eng.table("R")), {(1, "x"): 1})
        self.assertEqual(as_map(eng.result("j")), {(1, "a", 1, "x"): 1})
        # engine still works after the failed batch
        eng.apply_batch({"L": [((2, "b"), 1)]})
        self.assertEqual(eng.version, version_before + 1)
        self.assert_node_matches_interpreter(eng, "j")

    def test_signed_deltas_in_one_batch(self):
        eng = self.make_engine(["R"], [{"id": "r", "type": "scan", "table": "R"}])
        # net +2 for (1,); individual signed entries are allowed
        eng.apply_batch({"R": [((1,), 3), ((1,), -1), ((2,), 1), ((2,), -1)]})
        self.assertEqual(as_map(eng.table("R")), {(1,): 2})

    def test_except_all_clamps_at_zero_without_error(self):
        eng = self.make_engine(
            ["L", "R"],
            [
                {"id": "l", "type": "scan", "table": "L"},
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "e", "type": "except_all", "inputs": ["l", "r"]},
            ],
        )
        eng.apply_batch({"L": [((1,), 2)], "R": [((1,), 5)]})
        self.assertEqual(as_map(eng.result("e")), {})
        eng.apply_batch({"R": [((1,), -4)]})
        self.assertEqual(as_map(eng.result("e")), {(1,): 1})
        eng.apply_batch({"R": [((1,), 3)]})
        self.assertEqual(as_map(eng.result("e")), {})
        self.assert_node_matches_interpreter(eng, "e")


class SubscriptionTest(EngineTestCase):
    def test_add_remove_subscription_and_deterministic_order(self):
        eng = self.make_engine(
            ["R"],
            [
                {"id": "r", "type": "scan", "table": "R"},
                {"id": "d", "type": "distinct", "inputs": ["r"]},
            ],
        )
        s1 = eng.subscribe("r")
        s2 = eng.subscribe("d")
        records = eng.apply_batch({"R": [((2,), 1), ((1,), 1)]})
        self.assertEqual([rec["subscription"] for rec in records], [s1, s2])
        scan_rec = records[0]
        self.assertEqual(scan_rec["changes"], [[[1], 1], [[2], 1]])  # sorted
        self.assertEqual(scan_rec["version"], 1)
        self.assertEqual([rec["seq"] for rec in records], [1, 2])
        eng.unsubscribe(s1)
        records = eng.apply_batch({"R": [((3,), 1)]})
        self.assertEqual([rec["subscription"] for rec in records], [s2])
        with self.assertRaises(BagraError):
            eng.unsubscribe(s1)


if __name__ == "__main__":
    unittest.main()
