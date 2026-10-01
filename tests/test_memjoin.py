import itertools
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from memjoin.core import (  # noqa: E402
    Executor,
    MemSource,
    TableSource,
    canonical,
    run_query,
)


def reference(data, query):
    """Brute-force cartesian product + filter, then dedupe and sort."""
    tables = query["tables"]
    uniq = {}
    for combo in itertools.product(*(data[t] for t in tables)):
        ok = True
        for j in query["joins"]:
            lv = combo[tables.index(j["left"])].get(j["left_key"])
            rv = combo[tables.index(j["right"])].get(j["right_key"])
            if lv is None or rv is None or lv != rv:
                ok = False
                break
        if ok:
            merged = {}
            for row in combo:
                merged.update(row)
            uniq.setdefault(canonical(merged), merged)
    return [uniq[k] for k in sorted(uniq)]


def two_table_case():
    query = {
        "tables": ["A", "B"],
        "joins": [{"left": "A", "left_key": "k", "right": "B", "right_key": "k"}],
    }
    data = {
        "A": [
            {"k": 1, "a": "x"},
            {"k": 2, "a": "y"},
            {"k": None, "a": "null-key"},
            {"k": 1, "a": "x2"},
        ],
        "B": [
            {"k": 1, "b": 10},
            {"k": None, "b": 20},
            {"k": 3, "b": 30},
            {"k": 1, "b": 10},  # exact duplicate of first B row
        ],
    }
    return query, data


def chain_query(n):
    tables = [f"T{i}" for i in range(n)]
    joins = [
        {
            "left": tables[i],
            "left_key": f"k{i + 1}",
            "right": tables[i + 1],
            "right_key": f"k{i + 1}",
        }
        for i in range(n - 1)
    ]
    return {"tables": tables, "joins": joins}


class CorrectnessTests(unittest.TestCase):
    def test_two_table_matches_reference(self):
        query, data = two_table_case()
        expected = reference(data, query)
        self.assertEqual(len(expected), 2)  # NULL keys dropped, dupes removed
        for budget in (1, 2, 3, 1000):
            rows, _ = run_query(query, data, budget)
            self.assertEqual(rows, expected, f"budget={budget}")

    def test_null_keys_never_match(self):
        query, data = two_table_case()
        rows, _ = run_query(query, data, 4)
        self.assertTrue(all(r["k"] is not None for r in rows))
        self.assertNotIn({"k": None, "a": "null-key", "b": 20}, rows)

    def test_result_is_sorted_and_deduped(self):
        query, data = two_table_case()
        rows, _ = run_query(query, data, 2)
        keys = [canonical(r) for r in rows]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(keys), len(set(keys)))

    def test_three_table_chain_matches_reference(self):
        query = chain_query(3)
        data = {
            "T0": [{"k1": i % 4, "v0": i} for i in range(6)]
            + [{"k1": None, "v0": 99}],
            "T1": [{"k1": i % 3, "k2": i % 5, "v1": i} for i in range(7)],
            "T2": [{"k2": i % 4, "v2": i} for i in range(5)]
            + [{"k2": None, "v2": 98}],
        }
        expected = reference(data, query)
        for budget in (1, 2, 5, 100):
            rows, trace = run_query(query, data, budget)
            self.assertEqual(rows, expected, f"budget={budget}")
            self.assertEqual(len(trace), 2)

    def test_four_table_chain_matches_reference(self):
        query = chain_query(4)
        data = {
            "T0": [{"k1": i % 3, "a": i} for i in range(5)],
            "T1": [{"k1": i % 4, "k2": i % 3, "b": i} for i in range(6)],
            "T2": [{"k2": i % 3, "k3": i % 2, "c": i} for i in range(5)],
            "T3": [{"k3": i % 2, "d": i} for i in range(4)]
            + [{"k3": None, "d": 9}],
        }
        expected = reference(data, query)
        for budget in (2, 3, 50):
            rows, trace = run_query(query, data, budget)
            self.assertEqual(rows, expected, f"budget={budget}")
            self.assertEqual(len(trace), 3)

    def test_duplicate_inputs_collapse(self):
        query = {
            "tables": ["A", "B"],
            "joins": [
                {"left": "A", "left_key": "k", "right": "B", "right_key": "k"}
            ],
        }
        data = {
            "A": [{"k": 1, "x": "p"}, {"k": 1, "x": "p"}],
            "B": [{"k": 1, "y": "q"}, {"k": 1, "y": "q"}],
        }
        rows, _ = run_query(query, data, 10)
        self.assertEqual(rows, [{"k": 1, "x": "p", "y": "q"}])


class PlanningTests(unittest.TestCase):
    def big_data(self):
        query = {
            "tables": ["A", "B"],
            "joins": [
                {"left": "A", "left_key": "k", "right": "B", "right_key": "k"}
            ],
        }
        data = {
            "A": [{"k": i, "a": f"a{i}"} for i in range(60)],
            "B": [{"k": i, "b": f"b{i}"} for i in range(60)],
        }
        return query, data

    def test_small_budget_triggers_partitioning(self):
        query, data = self.big_data()
        rows, trace = run_query(query, data, 3)
        self.assertEqual(rows, reference(data, query))
        self.assertEqual(trace[0]["algorithm"], "grace_hash")
        self.assertGreaterEqual(trace[0]["partitions"], 2)

    def test_large_budget_picks_cheaper_plan(self):
        query, data = self.big_data()
        small_rows, small_trace = run_query(query, data, 3)
        large_rows, large_trace = run_query(query, data, 1000)
        self.assertEqual(small_rows, large_rows)
        small_reads = sum(s["rows_read"] for s in small_trace)
        large_reads = sum(s["rows_read"] for s in large_trace)
        self.assertLess(large_reads, small_reads)
        self.assertEqual(large_reads, 120)  # |A| + |B|, single pass
        self.assertEqual(large_trace[0]["partitions"], 0)

    def test_block_nested_loop_selected_when_cheapest(self):
        # |A|=1000, |B|=600, M=500:
        #   BNLJ(A outer) = 1000 + 2*600 = 2200
        #   GHJ (partitioned, build=600>M) = 2*(1000+600) = 3200
        query = {
            "tables": ["A", "B"],
            "joins": [
                {"left": "A", "left_key": "k", "right": "B", "right_key": "k"}
            ],
        }
        data = {
            "A": [{"k": i, "a": i} for i in range(1000)],
            "B": [{"k": i, "b": i} for i in range(600)],
        }
        rows, trace = run_query(query, data, 500)
        self.assertEqual(trace[0]["algorithm"], "block_nested_loop")
        self.assertEqual(rows, reference(data, query))
        self.assertEqual(trace[0]["rows_read"], 2200)

    def test_grace_hash_falls_back_under_extreme_skew(self):
        # All keys identical: hash partitioning cannot shrink the build side,
        # so execution must fall back (to BNLJ) and still be correct.
        query = {
            "tables": ["A", "B"],
            "joins": [
                {"left": "A", "left_key": "k", "right": "B", "right_key": "k"}
            ],
        }
        data = {
            "A": [{"k": 7, "a": i} for i in range(10)],
            "B": [{"k": 7, "b": i} for i in range(10)],
        }
        rows, _ = run_query(query, data, 2)
        self.assertEqual(rows, reference(data, query))
        self.assertEqual(len(rows), 100)

    def test_temp_files_cleaned_up(self):
        import glob
        import tempfile as tf

        query, data = self.big_data()
        before = set(glob.glob(str(Path(tf.gettempdir()) / "memjoin-*")))
        run_query(query, data, 3)
        after = set(glob.glob(str(Path(tf.gettempdir()) / "memjoin-*")))
        self.assertEqual(before, after)


class ExecutorUnitTests(unittest.TestCase):
    def setUp(self):
        self.data = {
            "A": [{"k": 1, "a": "x"}, {"k": 2, "a": "y"}, {"k": None, "a": "n"}],
            "B": [{"k": 1, "b": "p"}, {"k": 1, "b": "q"}, {"k": None, "b": "z"}],
        }
        self.conds = [("k", "k")]

    def sources(self, ex):
        return TableSource(ex, "A"), TableSource(ex, "B")

    def test_nlj_direct(self):
        ex = Executor(self.data, 1)
        a, b = self.sources(ex)
        rows = list(ex.nlj(a, b, self.conds))
        self.assertEqual(
            rows,
            [
                {"k": 1, "a": "x", "b": "p"},
                {"k": 1, "a": "x", "b": "q"},
            ],
        )
        self.assertEqual(ex.rows_read, 3 + 3 * 3)  # |A| + |A|*|B|

    def test_bnlj_direct(self):
        ex = Executor(self.data, 2)
        a, b = self.sources(ex)
        rows = list(ex.bnlj(a, b, self.conds))
        self.assertEqual(len(rows), 2)
        self.assertEqual(ex.rows_read, 3 + 2 * 3)  # |A| + ceil(|A|/2)*|B|

    def test_ghj_direct_with_mem_source(self):
        ex = Executor(self.data, 10)
        a = MemSource(self.data["A"])
        b = MemSource(self.data["B"])
        rows = ex.ghj(a, b, ["k"], ["k"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(ex.rows_read, 0)  # in-memory sources read for free


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "memjoin", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def write_json(self, obj):
        fd, path = tempfile.mkstemp(suffix=".json")
        with open(fd, "w") as fh:
            json.dump(obj, fh)
        self.addCleanup(Path(path).unlink)
        return path

    def test_cli_end_to_end(self):
        query, data = two_table_case()
        qpath = self.write_json(query)
        dpath = self.write_json(data)
        proc = self.run_cli(qpath, dpath, "--budget", "2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["rows"], reference(data, query))
        self.assertIn("plan_trace", out)
        self.assertEqual(out["plan_trace"][0]["step"], 1)

    def test_cli_rejects_non_positive_budget(self):
        query, data = two_table_case()
        qpath = self.write_json(query)
        dpath = self.write_json(data)
        for bad in ("0", "-3", "abc", "2.5"):
            proc = self.run_cli(qpath, dpath, "--budget", bad)
            self.assertEqual(proc.returncode, 2, f"--budget {bad}")
            self.assertEqual(proc.stdout, "")

    def test_cli_rejects_missing_files(self):
        proc = self.run_cli("nope.json", "nope2.json", "--budget", "5")
        self.assertEqual(proc.returncode, 2)

    def test_cli_rejects_bad_query(self):
        qpath = self.write_json({"tables": ["only_one"], "joins": []})
        dpath = self.write_json({"only_one": []})
        proc = self.run_cli(qpath, dpath, "--budget", "5")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
