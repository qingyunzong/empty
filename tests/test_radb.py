import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from radb import engine

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------
# Independent reference algorithm: brute-force enumeration of ALL
# permutations, computing the cost model from scratch.
# ---------------------------------------------------------------------

def reference_scan_cards(tables, catalog, filters):
    cards = {}
    for t in tables:
        card = float(catalog[t]["rows"])
        for f in filters:
            if f["table"] != t:
                continue
            ndv = catalog[t]["ndv"][f["column"]]
            if f["op"] == "=":
                card *= 1.0 / ndv
            else:
                card *= 1.0 / 3.0
        cards[t] = card
    return cards


def reference_cost(order, scan, catalog, conds):
    cost = sum(scan[t] for t in order)
    card = scan[order[0]]
    ndv = {}
    for t in order:
        for c, n in catalog[t]["ndv"].items():
            ndv[(t, c)] = n
    present = {order[0]}
    used = set()
    for t in order[1:]:
        new_card = card * scan[t]
        for i, (a, b) in enumerate(conds):
            if i in used:
                continue
            if (a[0] in present or a[0] == t) and (b[0] in present or b[0] == t) \
                    and (a[0] == t or b[0] == t):
                new_card /= max(ndv[a], ndv[b])
                ndv[a] = ndv[b] = min(ndv[a], ndv[b])
                used.add(i)
        card = new_card
        cost += card
        present.add(t)
    return cost


def reference_best(tables, scan, catalog, conds):
    scored = []
    for perm in itertools.permutations(tables):
        scored.append((reference_cost(perm, scan, catalog, conds), list(perm)))
    best_cost = min(c for c, _ in scored)
    best_orders = [o for c, o in scored if abs(c - best_cost) < 1e-6]
    return best_cost, sorted(best_orders)


# ---------------------------------------------------------------------

class Helper(unittest.TestCase):
    def make_dir(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return tmp.name

    def write_json(self, directory, name, obj):
        path = os.path.join(directory, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return path

    def write_csv(self, directory, name, header, rows):
        path = os.path.join(directory, name)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(",".join(header) + "\n")
            for row in rows:
                fh.write(",".join(str(v) for v in row) + "\n")
        return path

    def run_cli(self, *args, cwd=REPO_ROOT):
        return subprocess.run(
            [sys.executable, "-m", "radb", *args],
            capture_output=True, text=True, cwd=cwd)


THREE_TABLE_CATALOG = {
    "A": {"rows": 1000, "ndv": {"a": 100}},
    "B": {"rows": 10, "ndv": {"a": 100, "b": 10}},
    "C": {"rows": 500, "ndv": {"b": 10}},
}
THREE_TABLE_CONDS = [(("A", "a"), ("B", "a")), (("B", "b"), ("C", "b"))]


class TestSelectivity(Helper):
    def test_equality_selectivity_is_inverse_ndv(self):
        self.assertAlmostEqual(engine.selectivity("=", 50), 1.0 / 50)

    def test_comparison_selectivity_is_one_third(self):
        self.assertAlmostEqual(engine.selectivity("<", 50), 1.0 / 3.0)
        self.assertAlmostEqual(engine.selectivity(">", 7), 1.0 / 3.0)


class TestThreeTableOptimalOrder(Helper):
    """Optimal left-deep order must differ from the written FROM order."""

    def _run(self):
        tmp = self.make_dir()
        catalog_path = self.write_json(tmp, "catalog.json", THREE_TABLE_CATALOG)
        query = {
            "select": ["A.a"],
            "from": ["A", "C", "B"],  # written order is deliberately bad
            "where": [
                {"op": "=", "left": "A.a", "right": "B.a"},
                {"op": "=", "left": "B.b", "right": "C.b"},
            ],
        }
        query_path = self.write_json(tmp, "query.json", query)
        self.write_csv(tmp, "A.csv", ["a"], [[i] for i in range(5)])
        self.write_csv(tmp, "B.csv", ["a", "b"], [[i, i] for i in range(5)])
        self.write_csv(tmp, "C.csv", ["b"], [[i] for i in range(5)])
        return tmp, query_path, catalog_path

    def test_optimal_order_differs_from_written_order(self):
        tmp, query_path, catalog_path = self._run()
        result = engine.run_query(query_path, catalog_path, tmp)
        self.assertEqual(result["order"], ["A", "B", "C"])
        self.assertNotEqual(result["order"], ["A", "C", "B"])
        # hand-computed: scans 1510 + A*B join 100 + (AB)*C join 5000
        self.assertAlmostEqual(result["cost"], 6610.0)

    def test_written_order_is_much_more_expensive(self):
        scan = {"A": 1000.0, "B": 10.0, "C": 500.0}
        written = reference_cost(["A", "C", "B"], scan,
                                 THREE_TABLE_CATALOG, THREE_TABLE_CONDS)
        optimal = reference_cost(["A", "B", "C"], scan,
                                 THREE_TABLE_CATALOG, THREE_TABLE_CONDS)
        self.assertGreater(written, optimal)


class TestTieBreak(Helper):
    """Equal-cost orders must be broken by lexicographic table names."""

    CATALOG = {
        "A": {"rows": 100, "ndv": {"a": 10}},
        "B": {"rows": 50, "ndv": {"a": 10}},
        "C": {"rows": 50, "ndv": {"a": 10}},
    }
    CONDS = [(("A", "a"), ("B", "a")), (("A", "a"), ("C", "a"))]

    def test_tie_exists_and_lexicographic_order_wins(self):
        tables = ["A", "B", "C"]
        scan = reference_scan_cards(tables, self.CATALOG, [])
        best_cost, best_orders = reference_best(tables, scan,
                                                self.CATALOG, self.CONDS)
        # prove the tie really exists in the reference enumeration
        self.assertGreater(len(best_orders), 1)
        self.assertEqual(best_orders[0], ["A", "B", "C"])

        order, cost = engine.best_join_order(tables, scan, self.CATALOG,
                                             self.CONDS)
        self.assertEqual(order, ["A", "B", "C"])
        self.assertAlmostEqual(cost, best_cost)


class TestReferenceEnumeration(Helper):
    """Optimizer must match an independent all-permutations reference."""

    def test_random_catalogs_match_reference(self):
        rng = random.Random(20261002)
        for trial in range(25):
            names = ["T1", "T2", "T3", "T4"]
            catalog = {}
            for n in names:
                catalog[n] = {
                    "rows": rng.choice([10, 50, 100, 500, 1000]),
                    "ndv": {"j": rng.choice([2, 5, 10, 50, 100]),
                            "f": rng.choice([2, 10, 100])},
                }
            conds = [(("T1", "j"), ("T2", "j")), (("T2", "j"), ("T3", "j")),
                     (("T3", "j"), ("T4", "j"))]
            filters = []
            if trial % 2:
                filters.append({"table": rng.choice(names), "column": "f",
                                "op": rng.choice(["=", "<", ">"]), "value": 1})
            scan = reference_scan_cards(names, catalog, filters)
            best_cost, best_orders = reference_best(names, scan, catalog, conds)
            order, cost = engine.best_join_order(names, scan, catalog, conds)
            self.assertAlmostEqual(cost, best_cost, places=6,
                                   msg=f"trial {trial}")
            self.assertEqual(order, best_orders[0], msg=f"trial {trial}")


class TestExecution(Helper):
    def test_end_to_end_dedup_and_sort(self):
        tmp = self.make_dir()
        catalog = {
            "A": {"rows": 4, "ndv": {"a": 3, "b": 3}},
            "B": {"rows": 3, "ndv": {"a": 2, "c": 2}},
        }
        catalog_path = self.write_json(tmp, "catalog.json", catalog)
        self.write_csv(tmp, "A.csv", ["a", "b"],
                       [[1, 10], [2, 20], [3, 30], [2, 20]])
        self.write_csv(tmp, "B.csv", ["a", "c"],
                       [[2, "x"], [2, "y"], [4, "z"]])
        query = {
            "select": ["A.a", "B.c"],
            "from": ["A", "B"],
            "where": [
                {"op": "=", "left": "A.a", "right": "B.a"},
                {"op": "<", "left": "A.b", "right": 30},
            ],
        }
        query_path = self.write_json(tmp, "query.json", query)
        result = engine.run_query(query_path, catalog_path, tmp)
        # filter A.b < 30 keeps (1,10),(2,20),(2,20); join on a=2 gives
        # (2,x),(2,y) twice each; set semantics dedups; JSON-repr sorted.
        self.assertEqual(result["rows"], [[2, "x"], [2, "y"]])
        self.assertEqual(result["columns"], ["A.a", "B.c"])

    def test_cli_success_writes_output_file(self):
        tmp = self.make_dir()
        catalog_path = self.write_json(tmp, "catalog.json",
                                       {"A": {"rows": 2, "ndv": {"a": 2}}})
        self.write_csv(tmp, "A.csv", ["a"], [[1], [2]])
        query_path = self.write_json(tmp, "query.json",
                                     {"select": ["A.a"], "from": ["A"]})
        out = os.path.join(tmp, "out.json")
        proc = self.run_cli(query_path, catalog_path, tmp, out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out, encoding="utf-8") as fh:
            result = json.load(fh)
        self.assertEqual(result["rows"], [[1], [2]])
        self.assertEqual(result["order"], ["A"])


class TestErrors(Helper):
    """Bad queries: exit code 2, JSON error on stdout, no result file."""

    def _setup(self):
        tmp = self.make_dir()
        catalog = {
            "A": {"rows": 4, "ndv": {"a": 3, "b": 3}},
            "B": {"rows": 3, "ndv": {"a": 2}},
        }
        catalog_path = self.write_json(tmp, "catalog.json", catalog)
        self.write_csv(tmp, "A.csv", ["a", "b"], [[1, 1]])
        self.write_csv(tmp, "B.csv", ["a"], [[1]])
        return tmp, catalog_path

    def _assert_error(self, proc, out_path, fragment):
        self.assertEqual(proc.returncode, 2, proc.stderr)
        payload = json.loads(proc.stdout)  # stdout must be a JSON error object
        self.assertIn("error", payload)
        self.assertIn(fragment, payload["error"])
        self.assertFalse(os.path.exists(out_path),
                         "no result file may be produced on error")

    def test_unknown_column(self):
        tmp, catalog_path = self._setup()
        query_path = self.write_json(tmp, "query.json",
                                     {"select": ["A.zz"], "from": ["A"]})
        out = os.path.join(tmp, "out.json")
        proc = self.run_cli(query_path, catalog_path, tmp, out)
        self._assert_error(proc, out, "unknown column")

    def test_ambiguous_column(self):
        tmp, catalog_path = self._setup()
        query = {"select": ["a"], "from": ["A", "B"],
                 "where": [{"op": "=", "left": "A.a", "right": "B.a"}]}
        query_path = self.write_json(tmp, "query.json", query)
        out = os.path.join(tmp, "out.json")
        proc = self.run_cli(query_path, catalog_path, tmp, out)
        self._assert_error(proc, out, "ambiguous column")

    def test_missing_csv_file(self):
        tmp, catalog_path = self._setup()
        os.remove(os.path.join(tmp, "B.csv"))
        query = {"select": ["A.a"], "from": ["A", "B"],
                 "where": [{"op": "=", "left": "A.a", "right": "B.a"}]}
        query_path = self.write_json(tmp, "query.json", query)
        out = os.path.join(tmp, "out.json")
        proc = self.run_cli(query_path, catalog_path, tmp, out)
        self._assert_error(proc, out, "missing file")

    def test_missing_query_file(self):
        tmp, catalog_path = self._setup()
        out = os.path.join(tmp, "out.json")
        proc = self.run_cli(os.path.join(tmp, "nope.json"),
                            catalog_path, tmp, out)
        self._assert_error(proc, out, "missing file")


if __name__ == "__main__":
    unittest.main()
