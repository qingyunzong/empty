"""Tests for the radb mini relational database.

The join-order tests validate the engine against an *independent* reference
algorithm (`reference_orders`) that enumerates every permutation of the
tables with itertools.permutations and applies the documented cost formulas
directly.
"""

import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from radb import engine  # noqa: E402


# ---------------------------------------------------------------------------
# Independent reference algorithm (written separately from radb.engine)
# ---------------------------------------------------------------------------

def reference_orders(catalog, filters, joins, tables):
    """Enumerate ALL permutations; return a sorted list of (cost, order).

    filters: {table: [(column, op), ...]}   (constants only)
    joins:   [((t1, c1), (t2, c2)), ...]
    """
    def base_card(table):
        card = Fraction(catalog[table]["cardinality"])
        for column, op in filters.get(table, []):
            if op == "=":
                card *= Fraction(1, catalog[table]["columns"][column]["ndv"])
            else:  # '<' or '>'
                card *= Fraction(1, 3)
        return card

    def cost(order):
        total = Fraction(0)
        acc_card = None
        acc_tables = set()
        for table in order:
            total += base_card(table)
            if acc_card is None:
                acc_card = base_card(table)
            else:
                join_card = acc_card * base_card(table)
                for (t1, c1), (t2, c2) in joins:
                    if (t1 in acc_tables and t2 == table) or \
                            (t2 in acc_tables and t1 == table):
                        join_card /= max(catalog[t1]["columns"][c1]["ndv"],
                                         catalog[t2]["columns"][c2]["ndv"])
                total += join_card
                acc_card = join_card
            acc_tables.add(table)
        return total

    return sorted((cost(perm), perm) for perm in itertools.permutations(tables))


def reference_best_order(catalog, filters, joins, tables):
    ranked = reference_orders(catalog, filters, joins, tables)
    best_cost = ranked[0][0]
    tied = [order for cost, order in ranked if cost == best_cost]
    return best_cost, min(tied), tied


# ---------------------------------------------------------------------------
# CLI scenario helper
# ---------------------------------------------------------------------------

class Scenario:
    def __init__(self, root):
        self.root = root
        self.tables_dir = os.path.join(root, "tables")
        os.makedirs(self.tables_dir, exist_ok=True)

    def write_query(self, obj):
        path = os.path.join(self.root, "query.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(obj, handle)
        return path

    def write_catalog(self, obj):
        path = os.path.join(self.root, "catalog.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(obj, handle)
        return path

    def write_table(self, name, header, rows):
        path = os.path.join(self.tables_dir, name + ".csv")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(",".join(header) + "\n")
            for row in rows:
                handle.write(",".join(str(v) for v in row) + "\n")
        return path

    def run_cli(self, query="query.json", catalog="catalog.json", tables="tables"):
        env = dict(os.environ)
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-m", "radb", query, catalog, tables],
            cwd=self.root, env=env, capture_output=True, text=True)

    def result_path(self):
        return os.path.join(self.root, "result.json")

    def read_result(self):
        with open(self.result_path(), encoding="utf-8") as handle:
            return json.load(handle)


# ---------------------------------------------------------------------------
# Join-order optimization tests (validated against the reference algorithm)
# ---------------------------------------------------------------------------

class JoinOrderTests(unittest.TestCase):
    CATALOG = {
        "A": {"cardinality": 1000, "columns": {"x": {"ndv": 100}, "f": {"ndv": 10}}},
        "B": {"cardinality": 1000, "columns": {"x": {"ndv": 100}, "y": {"ndv": 50}}},
        "C": {"cardinality": 10, "columns": {"y": {"ndv": 50}}},
    }

    def test_optimal_order_differs_from_written_order(self):
        """FROM is A,B,C but the cheapest left-deep order is B,C,A."""
        query = {
            "select": ["A.x"],
            "from": ["A", "B", "C"],
            "where": [
                {"left": "A.x", "op": "=", "right": "B.x"},
                {"left": "B.y", "op": "=", "right": "C.y"},
                {"left": "A.f", "op": "=", "right": 5},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query(query)
            sc.write_catalog(self.CATALOG)
            sc.write_table("A", ["x", "f"], [[1, 5]])
            sc.write_table("B", ["x", "y"], [[1, 7]])
            sc.write_table("C", ["y"], [[7]])
            proc = sc.run_cli()

            self.assertEqual(proc.returncode, 0, proc.stderr)
            summary = json.loads(proc.stdout)
            self.assertEqual(summary["join_order"], ["B", "C", "A"])
            self.assertNotEqual(summary["join_order"], query["from"])

            # Cross-check against the independent full-permutation reference.
            filters = {"A": [("f", "=")]}
            joins = [(("A", "x"), ("B", "x")), (("B", "y"), ("C", "y"))]
            best_cost, best_order, _ = reference_best_order(
                self.CATALOG, filters, joins, ["A", "B", "C"])
            self.assertEqual(tuple(summary["join_order"]), best_order)
            self.assertEqual(Fraction(summary["cost"]), best_cost)
            written_cost = dict(
                (order, cost) for cost, order in reference_orders(
                    self.CATALOG, filters, joins, ["A", "B", "C"])
            )[("A", "B", "C")]
            self.assertGreater(written_cost, best_cost)

    def test_tie_broken_by_lexicographic_order(self):
        """Four orders tie on cost; the lexicographically smallest must win."""
        catalog = {
            "A": {"cardinality": 100, "columns": {"x": {"ndv": 10}, "y": {"ndv": 10}}},
            "B": {"cardinality": 100, "columns": {"x": {"ndv": 10}}},
            "C": {"cardinality": 100, "columns": {"y": {"ndv": 10}}},
        }
        query = {
            "select": ["A.x"],
            "from": ["C", "B", "A"],  # written order is deliberately not optimal
            "where": [
                {"left": "A.x", "op": "=", "right": "B.x"},
                {"left": "A.y", "op": "=", "right": "C.y"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query(query)
            sc.write_catalog(catalog)
            sc.write_table("A", ["x", "y"], [[1, 2]])
            sc.write_table("B", ["x"], [[1]])
            sc.write_table("C", ["y"], [[2]])
            proc = sc.run_cli()

            self.assertEqual(proc.returncode, 0, proc.stderr)
            summary = json.loads(proc.stdout)

            joins = [(("A", "x"), ("B", "x")), (("A", "y"), ("C", "y"))]
            best_cost, best_order, tied = reference_best_order(
                catalog, {}, joins, ["A", "B", "C"])
            self.assertGreater(len(tied), 1, "scenario must produce a real cost tie")
            self.assertEqual(tuple(summary["join_order"]), best_order)
            self.assertEqual(summary["join_order"], ["A", "B", "C"])
            self.assertEqual(Fraction(summary["cost"]), best_cost)

    def test_randomized_against_full_permutation_reference(self):
        """Seeded random 4-table scenarios checked against the reference."""
        rng = random.Random(20261001)
        tables = ["P", "Q", "R", "S"]
        for _ in range(25):
            catalog = {
                t: {"cardinality": rng.choice([10, 100, 1000]),
                    "columns": {"a": {"ndv": rng.choice([1, 5, 50])},
                                "b": {"ndv": rng.choice([1, 5, 50])}}}
                for t in tables
            }
            joins = []
            where = []
            for left, right, col in (("P", "Q", "a"), ("Q", "R", "b"), ("R", "S", "a")):
                if rng.random() < 0.8:
                    joins.append(((left, col), (right, col)))
                    where.append({"left": f"{left}.{col}", "op": "=",
                                  "right": f"{right}.{col}"})
            filters = {}
            for t in tables:
                if rng.random() < 0.5:
                    col = rng.choice(["a", "b"])
                    op = rng.choice(["=", "<", ">"])
                    filters.setdefault(t, []).append((col, op))
                    where.append({"left": f"{t}.{col}", "op": op, "right": 1})

            query = {"select": ["P.a"], "from": list(tables), "where": where}
            with tempfile.TemporaryDirectory() as tmp:
                sc = Scenario(tmp)
                sc.write_query(query)
                sc.write_catalog(catalog)
                for t in tables:
                    sc.write_table(t, ["a", "b"], [[1, 1]])
                proc = sc.run_cli()
                self.assertEqual(proc.returncode, 0, proc.stderr)
                summary = json.loads(proc.stdout)

            best_cost, best_order, _ = reference_best_order(
                catalog, filters, joins, tables)
            self.assertEqual(tuple(summary["join_order"]), best_order)
            self.assertEqual(Fraction(summary["cost"]), best_cost)


# ---------------------------------------------------------------------------
# Cost-model unit tests
# ---------------------------------------------------------------------------

class CostModelTests(unittest.TestCase):
    def setUp(self):
        # Catalogs inside the engine are in the loaded (flattened) shape
        # produced by engine.load_catalog: columns map names to NDV ints.
        self.catalog = {
            "R": {"cardinality": 900, "columns": {"a": 30, "b": 9}},
            "S": {"cardinality": 600, "columns": {"a": 60}},
        }

    def test_equality_selectivity_is_one_over_ndv(self):
        filters = [(("R", "a"), "=", ("const", 1))]
        self.assertEqual(
            engine.base_cardinality("R", self.catalog, filters), Fraction(900, 30))

    def test_comparison_selectivity_is_one_third(self):
        for op in ("<", ">"):
            filters = [(("R", "a"), op, ("const", 1))]
            self.assertEqual(
                engine.base_cardinality("R", self.catalog, filters), Fraction(900, 3))

    def test_join_cardinality_divides_by_max_ndv(self):
        base = {"R": Fraction(900), "S": Fraction(600)}
        joins = [(("R", "a"), ("S", "a"))]
        cost = engine.order_cost(("R", "S"), base, self.catalog, joins)
        expected = Fraction(900) + Fraction(600) + Fraction(900 * 600, 60)
        self.assertEqual(cost, expected)


# ---------------------------------------------------------------------------
# End-to-end execution tests
# ---------------------------------------------------------------------------

class ExecutionTests(unittest.TestCase):
    def test_end_to_end_dedup_and_json_sort_order(self):
        catalog = {
            "R": {"cardinality": 4, "columns": {"a": {"ndv": 3}, "b": {"ndv": 2}}},
            "S": {"cardinality": 4, "columns": {"a": {"ndv": 3}, "c": {"ndv": 4}}},
        }
        query = {
            "select": ["R.b", "S.c"],
            "from": ["R", "S"],
            "where": [
                {"left": "R.a", "op": "=", "right": "S.a"},
                {"left": "R.b", "op": "=", "right": {"const": "x"}},
                {"left": "S.c", "op": "<", "right": 30},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query(query)
            sc.write_catalog(catalog)
            sc.write_table("R", ["a", "b"],
                           [[1, "x"], [2, "y"], [3, "x"], [3, "x"]])  # duplicate row
            sc.write_table("S", ["a", "c"],
                           [[1, 10], [2, 20], [3, 9], [3, 30]])       # 30 filtered out
            proc = sc.run_cli()
            self.assertEqual(proc.returncode, 0, proc.stderr)

            rows = sc.read_result()
            # Set semantics: the duplicated (3, x) join result collapses.
            # Sorted by JSON representation: "10" < "9" as strings.
            self.assertEqual(rows, [{"R.b": "x", "S.c": 10},
                                    {"R.b": "x", "S.c": 9}])
            summary = json.loads(proc.stdout)
            self.assertEqual(summary["rows"], 2)

    def test_unqualified_column_references_resolve(self):
        catalog = {
            "R": {"cardinality": 2, "columns": {"a": {"ndv": 2}}},
            "S": {"cardinality": 2, "columns": {"b": {"ndv": 2}}},
        }
        query = {"select": ["a", "b"], "from": ["R", "S"],
                 "where": [{"left": "a", "op": "<", "right": 5}]}
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query(query)
            sc.write_catalog(catalog)
            sc.write_table("R", ["a"], [[1], [9]])
            sc.write_table("S", ["b"], [[7]])
            proc = sc.run_cli()
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(sc.read_result(), [{"R.a": 1, "S.b": 7}])


# ---------------------------------------------------------------------------
# Error handling tests: exit code 2, JSON error on stdout, no result file
# ---------------------------------------------------------------------------

class ErrorTests(unittest.TestCase):
    CATALOG = {
        "R": {"cardinality": 10, "columns": {"a": {"ndv": 5}}},
        "S": {"cardinality": 10, "columns": {"a": {"ndv": 5}, "b": {"ndv": 5}}},
    }

    def _assert_error(self, proc, sc, fragment):
        self.assertEqual(proc.returncode, 2, proc.stderr)
        message = json.loads(proc.stdout)  # stdout must be a single JSON object
        self.assertIn("error", message)
        self.assertIn(fragment, message["error"])
        self.assertFalse(os.path.exists(sc.result_path()),
                         "no result file may be produced on error")

    def test_unknown_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query({"select": ["R.nope"], "from": ["R"]})
            sc.write_catalog(self.CATALOG)
            sc.write_table("R", ["a"], [[1]])
            self._assert_error(sc.run_cli(), sc, "unknown column")

    def test_ambiguous_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query({"select": ["a"], "from": ["R", "S"]})
            sc.write_catalog(self.CATALOG)
            sc.write_table("R", ["a"], [[1]])
            sc.write_table("S", ["a", "b"], [[1, 2]])
            self._assert_error(sc.run_cli(), sc, "ambiguous column")

    def test_missing_table_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query({"select": ["R.a"], "from": ["R"]})
            sc.write_catalog(self.CATALOG)
            # No R.csv written.
            self._assert_error(sc.run_cli(), sc, "not found")

    def test_missing_query_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_catalog(self.CATALOG)
            sc.write_table("R", ["a"], [[1]])
            self._assert_error(sc.run_cli(query="no_such_query.json"), sc, "not found")

    def test_missing_catalog_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query({"select": ["R.a"], "from": ["R"]})
            sc.write_table("R", ["a"], [[1]])
            self._assert_error(sc.run_cli(catalog="no_such_catalog.json"), sc, "not found")

    def test_unsupported_operator(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc = Scenario(tmp)
            sc.write_query({"select": ["R.a"], "from": ["R"],
                            "where": [{"left": "R.a", "op": ">=", "right": 1}]})
            sc.write_catalog(self.CATALOG)
            sc.write_table("R", ["a"], [[1]])
            self._assert_error(sc.run_cli(), sc, "unsupported operator")


if __name__ == "__main__":
    unittest.main()
