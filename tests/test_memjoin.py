"""End-to-end and unit tests for memjoin.

Correctness oracle: an independent brute-force cartesian product + filter
reference implementation (reference_join below).
"""

import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from memjoin.executor import run_query
from memjoin.jsonutil import canonical, qualify
from memjoin.planner import BNLJ, GHJ, NLJ


# ------------------------------------------------------------- reference

def reference_join(tables, edges, data):
    """Brute-force cartesian product + filter, set semantics, sorted."""
    combos = [{}]
    for t in tables:
        combos = [{**c, **qualify(t, row)} for c in combos for row in data[t]]
    out = set()
    for c in combos:
        ok = True
        for lt, la, rt, ra in edges:
            lv = c.get("{}.{}".format(lt, la))
            rv = c.get("{}.{}".format(rt, ra))
            if lv is None or rv is None or canonical(lv) != canonical(rv):
                ok = False
                break
        if ok:
            out.add(canonical(c))
    return [json.loads(s) for s in sorted(out)]


# ------------------------------------------------------------- fixtures

def two_table_case():
    tables = ["R", "S"]
    edges = [("R", "k", "S", "k")]
    data = {
        "R": [
            {"k": 1, "a": "x"}, {"k": 2, "a": "y"}, {"k": None, "a": "n"},
            {"k": 1, "a": "x"}, {"k": 3, "a": "z"},
        ],
        "S": [
            {"k": 1, "b": 10}, {"k": 1, "b": 11}, {"k": None, "b": 99},
            {"k": 4, "b": 40}, {"k": 1, "b": 10},
        ],
    }
    return tables, edges, data


def three_table_case():
    tables = ["A", "B", "C"]
    edges = [("A", "id", "B", "a_id"), ("B", "id", "C", "b_id")]
    data = {
        "A": [{"id": i, "v": "a{}".format(i)} for i in range(6)]
             + [{"id": None, "v": "nullA"}],
        "B": [{"id": 10 + i, "a_id": i % 4, "w": i} for i in range(8)]
             + [{"id": 99, "a_id": None, "w": -1}],
        "C": [{"b_id": 10 + (i % 8), "u": i} for i in range(10)]
             + [{"b_id": None, "u": -1}],
    }
    return tables, edges, data


def four_table_case():
    tables = ["T1", "T2", "T3", "T4"]
    edges = [
        ("T1", "k", "T2", "k"),
        ("T2", "j", "T3", "j"),
        ("T3", "h", "T4", "h"),
        ("T1", "k2", "T3", "k2"),
    ]
    data = {
        "T1": [{"k": i % 3, "k2": i % 2, "x": i} for i in range(5)],
        "T2": [{"k": i % 4, "j": i % 3, "y": i} for i in range(6)],
        "T3": [{"j": i % 3, "k2": i % 2, "h": i % 2, "z": i} for i in range(5)],
        "T4": [{"h": i % 2, "w": i} for i in range(4)]
              + [{"h": None, "w": 99}],
    }
    return tables, edges, data


# ------------------------------------------------------------- CLI tests

class CliTest(unittest.TestCase):
    def run_cli(self, query_obj, data_obj, budget):
        with tempfile.TemporaryDirectory() as d:
            qp = os.path.join(d, "query.json")
            dp = os.path.join(d, "data.json")
            with open(qp, "w") as fh:
                json.dump(query_obj, fh)
            with open(dp, "w") as fh:
                json.dump(data_obj, fh)
            return subprocess.run(
                [sys.executable, "-m", "memjoin", qp, dp, "--budget", str(budget)],
                capture_output=True, text=True, cwd=REPO_ROOT)

    def query_data(self):
        tables, edges, data = two_table_case()
        query = {"tables": tables,
                 "joins": [{"left": lt, "left_attr": la,
                            "right": rt, "right_attr": ra}
                           for lt, la, rt, ra in edges]}
        return query, data

    def test_budget_zero_exit_2(self):
        q, d = self.query_data()
        proc = self.run_cli(q, d, 0)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("positive integer", proc.stderr)

    def test_budget_negative_exit_2(self):
        q, d = self.query_data()
        self.assertEqual(self.run_cli(q, d, -3).returncode, 2)

    def test_budget_non_integer_exit_2(self):
        q, d = self.query_data()
        proc = self.run_cli(q, d, "abc")
        self.assertEqual(proc.returncode, 2)

    def test_missing_file_exit_2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "memjoin", "nope.json", "nope2.json",
             "--budget", "5"], capture_output=True, text=True, cwd=REPO_ROOT)
        self.assertEqual(proc.returncode, 2)

    def test_cli_happy_path(self):
        q, d = self.query_data()
        proc = self.run_cli(q, d, 4)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertIn("rows", result)
        self.assertIn("plan_trace", result)
        tables, edges, data = two_table_case()
        self.assertEqual(result["rows"], reference_join(tables, edges, data))


# ------------------------------------------------------------- correctness

class CorrectnessTest(unittest.TestCase):
    def check(self, case, budgets):
        tables, edges, data = case()
        expected = reference_join(tables, edges, data)
        for m in budgets:
            with self.subTest(budget=m):
                result = run_query(tables, edges, data, m)
                self.assertEqual(result["rows"], expected)

    def test_two_tables_all_budgets(self):
        self.check(two_table_case, budgets=(1, 2, 3, 5, 1000))

    def test_three_tables_all_budgets(self):
        self.check(three_table_case, budgets=(1, 2, 4, 7, 1000))

    def test_four_tables_all_budgets(self):
        self.check(four_table_case, budgets=(1, 2, 3, 1000))

    def test_null_keys_never_match(self):
        tables = ["R", "S"]
        edges = [("R", "k", "S", "k")]
        data = {"R": [{"k": None, "a": 1}, {"k": None, "a": 2}],
                "S": [{"k": None, "b": 3}]}
        result = run_query(tables, edges, data, 10)
        self.assertEqual(result["rows"], [])

    def test_set_semantics_dedup(self):
        tables = ["R", "S"]
        edges = [("R", "k", "S", "k")]
        data = {"R": [{"k": 1}, {"k": 1}, {"k": 1}],
                "S": [{"k": 1, "v": "a"}, {"k": 1, "v": "a"}]}
        result = run_query(tables, edges, data, 10)
        self.assertEqual(result["rows"], [{"R.k": 1, "S.k": 1, "S.v": "a"}])

    def test_output_sorted(self):
        tables, edges, data = three_table_case()
        result = run_query(tables, edges, data, 2)
        keys = [canonical(r) for r in result["rows"]]
        self.assertEqual(keys, sorted(keys))

    def test_multi_key_join(self):
        tables = ["R", "S"]
        edges = [("R", "a", "S", "a"), ("R", "b", "S", "b")]
        data = {
            "R": [{"a": 1, "b": 1}, {"a": 1, "b": 2}, {"a": 1, "b": None}],
            "S": [{"a": 1, "b": 1, "z": 9}, {"a": 1, "b": 2, "z": 8}],
        }
        for m in (1, 2, 50):
            result = run_query(tables, edges, data, m)
            self.assertEqual(result["rows"], reference_join(tables, edges, data))

    def test_empty_result_and_empty_table(self):
        tables = ["R", "S"]
        edges = [("R", "k", "S", "k")]
        data = {"R": [{"k": 1}], "S": []}
        for m in (1, 5):
            result = run_query(tables, edges, data, m)
            self.assertEqual(result["rows"], [])


# ------------------------------------------------------------- planning

class PlanningTest(unittest.TestCase):
    def test_small_budget_triggers_partitioning(self):
        tables = ["R", "S"]
        edges = [("R", "k", "S", "k")]
        data = {
            "R": [{"k": i % 7, "x": i} for i in range(30)],
            "S": [{"k": i % 5, "y": i} for i in range(25)],
        }
        result = run_query(tables, edges, data, 2)
        trace = result["plan_trace"]
        self.assertEqual(result["rows"], reference_join(tables, edges, data))
        self.assertGreater(trace["execution"]["partitions_created"], 0)
        self.assertGreater(trace["execution"]["temp_files_created"], 0)
        self.assertEqual(trace["execution"]["temp_files_created"],
                         trace["execution"]["temp_files_cleaned"])
        self.assertTrue(trace["execution"]["temp_dir_removed"])

    def test_large_budget_picks_cheaper_plan(self):
        tables = ["R", "S"]
        edges = [("R", "k", "S", "k")]
        data = {
            "R": [{"k": i % 7, "x": i} for i in range(30)],
            "S": [{"k": i % 5, "y": i} for i in range(25)],
        }
        small = run_query(tables, edges, data, 1)["plan_trace"]
        large = run_query(tables, edges, data, 10_000)["plan_trace"]
        self.assertLess(large["chosen"]["estimated_total_reads"],
                        small["chosen"]["estimated_total_reads"])
        # With a huge budget nothing needs partitioning or spilling.
        self.assertEqual(large["execution"]["partitions_created"], 0)
        self.assertEqual(large["execution"]["temp_files_created"], 0)
        # One pass over each input beats any loop-heavy plan.
        self.assertEqual(large["chosen"]["estimated_total_reads"], 30 + 25)

    def test_tie_break_algorithm_name(self):
        # |R| = |S| = 1, budget 2: NLJ, BNLJ and GHJ all read 2 rows.
        # The lexicographically smallest algorithm name must win.
        tables = ["R", "S"]
        edges = [("R", "k", "S", "k")]
        data = {"R": [{"k": 1}], "S": [{"k": 1}]}
        trace = run_query(tables, edges, data, 2)["plan_trace"]
        self.assertEqual(trace["chosen"]["algorithms"], [BNLJ])
        self.assertEqual(trace["chosen"]["estimated_total_reads"], 2)

    def test_tie_break_table_order(self):
        # Symmetric tables: both orders cost the same; lexicographic order wins.
        tables = ["B", "A"]
        edges = [("B", "k", "A", "k")]
        data = {"B": [{"k": 1, "v": 1}], "A": [{"k": 1, "v": 2}]}
        trace = run_query(tables, edges, data, 10)["plan_trace"]
        self.assertEqual(trace["chosen"]["table_order"], ["A", "B"])

    def test_all_three_algorithms_are_candidates(self):
        tables, edges, data = three_table_case()
        trace = run_query(tables, edges, data, 3)["plan_trace"]
        self.assertEqual(trace["candidates_considered"], 6 * 9)  # 3! * 3^2
        names = {a for c in trace["ranked_candidates"] for a in c["algorithms"]}
        self.assertTrue(names <= {NLJ, BNLJ, GHJ})

    def test_skewed_keys_fallback_still_correct(self):
        # All keys identical: hash partitioning cannot split; BNLJ fallback.
        tables = ["R", "S"]
        edges = [("R", "k", "S", "k")]
        data = {"R": [{"k": 7, "i": i} for i in range(20)],
                "S": [{"k": 7, "j": j} for j in range(15)]}
        result = run_query(tables, edges, data, 2)
        self.assertEqual(result["rows"], reference_join(tables, edges, data))
        self.assertGreater(result["plan_trace"]["execution"]["bnlj_fallbacks"], 0)

    def test_intermediate_spill(self):
        tables, edges, data = three_table_case()
        result = run_query(tables, edges, data, 1)
        self.assertEqual(result["rows"], reference_join(tables, edges, data))
        self.assertGreater(result["plan_trace"]["execution"]["spilled_intermediates"], 0)


if __name__ == "__main__":
    unittest.main()
