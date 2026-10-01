"""Enumerate small bag databases and short transaction sequences; verify
every published output and multiplicity against an independent,
non-incremental relational algebra interpreter."""

import itertools
import random
import unittest

from bagra import BagraError, Engine, evaluate


def as_map(result_list):
    return {tuple(row): count for row, count in result_list}


def make_engine(tables, node_specs):
    eng = Engine()
    for name in tables:
        eng.add_table(name)
    for spec in node_specs:
        eng.add_node(spec)
    return eng


def check_all(eng, node_ids, node_specs, prev_results, published):
    specs = {spec["id"]: spec for spec in node_specs}
    for nid in node_ids:
        expected = evaluate(nid, specs, eng.tables)
        actual = dict(eng.nodes[nid].state)
        assert actual == expected, f"node {nid}: {actual} != {expected}"
        # replaying this batch's published deltas on the previous full
        # result must reproduce the new full result
        replayed = dict(prev_results[nid])
        for rec in published:
            if rec["node"] != nid:
                continue
            for row, delta in rec["changes"]:
                row = tuple(row)
                new = replayed.get(row, 0) + delta
                if new:
                    replayed[row] = new
                else:
                    replayed.pop(row, None)
        assert replayed == expected, f"node {nid}: replay mismatch"
        prev_results[nid] = expected


GRAPHS = {
    "join_chain": (
        ["A", "B"],
        [
            {"id": "a", "type": "scan", "table": "A"},
            {"id": "b", "type": "scan", "table": "B"},
            {"id": "fa", "type": "filter", "inputs": ["a"],
             "predicate": {"op": "or", "args": [
                 {"op": "ge", "col": 0, "value": 1},
                 {"op": "is_null", "col": 0}]}},
            {"id": "j", "type": "join", "inputs": ["fa", "b"],
             "left_keys": [0], "right_keys": [0]},
            {"id": "p", "type": "project", "inputs": ["j"], "columns": [1, 3]},
            {"id": "d", "type": "distinct", "inputs": ["p"]},
        ],
        ["j", "p", "d"],
    ),
    "set_ops": (
        ["A", "B"],
        [
            {"id": "a", "type": "scan", "table": "A"},
            {"id": "b", "type": "scan", "table": "B"},
            {"id": "pa", "type": "project", "inputs": ["a"], "columns": [0]},
            {"id": "pb", "type": "project", "inputs": ["b"], "columns": [0]},
            {"id": "u", "type": "union_all", "inputs": ["pa", "pb"]},
            {"id": "i", "type": "intersect_all", "inputs": ["pa", "pb"]},
            {"id": "e", "type": "except_all", "inputs": ["pa", "pb"]},
            {"id": "du", "type": "distinct", "inputs": ["u"]},
        ],
        ["u", "i", "e", "du"],
    ),
    "self_join": (
        ["A"],
        [
            {"id": "a", "type": "scan", "table": "A"},
            {"id": "j", "type": "join", "inputs": ["a", "a"],
             "left_keys": [0], "right_keys": [0]},
            {"id": "p", "type": "project", "inputs": ["j"], "columns": [1, 3]},
        ],
        ["j", "p"],
    ),
}

DOMAIN = [None, 0, 1]


class RandomizedPropertyTest(unittest.TestCase):
    def test_random_databases_and_transactions(self):
        rng = random.Random(20261001)
        for graph_name, (tables, node_specs, outputs) in GRAPHS.items():
            for trial in range(40):
                eng = make_engine(tables, node_specs)
                for nid in outputs:
                    eng.subscribe(nid)
                prev = {nid: {} for nid in outputs}
                for _ in range(25):
                    changes = {}
                    for table in tables:
                        edits = []
                        for _ in range(rng.randrange(0, 4)):
                            row = tuple(rng.choice(DOMAIN) for _ in range(2))
                            edits.append((row, rng.choice([-2, -1, 1, 1, 2])))
                        if edits:
                            changes[table] = edits
                    snapshot_tables = {t: dict(d) for t, d in eng.tables.items()}
                    try:
                        published = eng.apply_batch(changes)
                    except BagraError:
                        # failed batch: full rollback, nothing published
                        self.assertEqual(snapshot_tables, eng.tables)
                        for nid in outputs:
                            self.assertEqual(prev[nid], dict(eng.nodes[nid].state))
                        continue
                    with self.subTest(graph=graph_name, trial=trial):
                        check_all(eng, outputs, node_specs, prev, published)


class ExhaustiveTinyTest(unittest.TestCase):
    """All databases over a 2-row domain with multiplicities 0..2, and all
    transaction sequences of length 3 built from single-row +/-1 edits."""

    ROWS = [(0,), (1,)]
    OPS = [(row, delta) for row in ROWS for delta in (1, -1)]
    NODE_SPECS = [
        {"id": "a", "type": "scan", "table": "A"},
        {"id": "f", "type": "filter", "inputs": ["a"],
         "predicate": {"op": "ge", "col": 0, "value": 0}},
        {"id": "d", "type": "distinct", "inputs": ["f"]},
        {"id": "p", "type": "project", "inputs": ["d"], "columns": [0]},
        {"id": "e", "type": "except_all", "inputs": ["a", "f"]},
        {"id": "i", "type": "intersect_all", "inputs": ["a", "f"]},
    ]
    OUTPUTS = ["d", "p", "e", "i"]

    def test_exhaustive(self):
        databases = [
            {row: count for row, count in zip(self.ROWS, counts) if count}
            for counts in itertools.product(range(3), repeat=2)
        ]
        sequences = list(itertools.product(self.OPS, repeat=3))
        specs = {spec["id"]: spec for spec in self.NODE_SPECS}
        checked = 0
        for db in databases:
            for seq in sequences:
                eng = make_engine(["A"], self.NODE_SPECS)
                for nid in self.OUTPUTS:
                    eng.subscribe(nid)
                eng.apply_batch({"A": [(row, c) for row, c in db.items()]})
                prev = {nid: dict(eng.nodes[nid].state) for nid in self.OUTPUTS}
                for row, delta in seq:
                    before = dict(eng.tables["A"])
                    try:
                        published = eng.apply_batch({"A": [(row, delta)]})
                    except BagraError:
                        self.assertEqual(before, eng.tables["A"])
                        continue
                    check_all(eng, self.OUTPUTS, self.NODE_SPECS, prev, published)
                    for nid in self.OUTPUTS:
                        expected = evaluate(nid, specs, eng.tables)
                        self.assertEqual(expected, dict(eng.nodes[nid].state))
                    checked += 1
        self.assertGreater(checked, 1000)


if __name__ == "__main__":
    unittest.main()
