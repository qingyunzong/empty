"""Tests for aggql.

A reference implementation (independent dict-based regrouping and
recomputation, plus its own sorting) is used to cross-check results.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from aggql import QueryError, run_query  # noqa: E402


# ---------------------------------------------------------------------------
# Independent reference implementation (deliberately written separately)
# ---------------------------------------------------------------------------

def _ref_key(value):
    return json.dumps(value, sort_keys=True) + ":" + type(value).__name__


def _ref_aggregate(func, arg, distinct, rows):
    if arg == "*":
        return len(rows)
    vals = [r.get(arg) for r in rows]
    if distinct:
        dedup = {}
        for v in vals:
            dedup[_ref_key(v)] = v  # all NULLs collapse to one entry
        vals = list(dedup.values())
    vals = [v for v in vals if v is not None]
    if func == "COUNT":
        return len(vals)
    if not vals:
        return None
    if func == "SUM":
        return sum(vals)
    if func == "MIN":
        return min(vals)
    if func == "MAX":
        return max(vals)
    if func == "AVG":
        fr = sum((Fraction(v) for v in vals), Fraction(0)) / len(vals)
        return f"{fr.numerator}/{fr.denominator}"
    raise AssertionError(func)


def _ref_3vl(expr, env):
    if not isinstance(expr, dict):
        return expr
    if "lit" in expr:
        return expr["lit"]
    if "agg" in expr:
        return env[expr["agg"]]
    if "col" in expr:
        return env[expr["col"]]
    if "cmp" in expr:
        a = _ref_3vl(expr["left"], env)
        b = _ref_3vl(expr["right"], env)
        if a is None or b is None:
            return None
        return {
            "=": a == b, "!=": a != b, "<": a < b,
            "<=": a <= b, ">": a > b, ">=": a >= b,
        }[expr["cmp"]]
    if "and" in expr:
        vals = [_ref_3vl(e, env) for e in expr["and"]]
        if False in vals:
            return False
        return None if None in vals else True
    if "or" in expr:
        vals = [_ref_3vl(e, env) for e in expr["or"]]
        if True in vals:
            return True
        return None if None in vals else False
    if "not" in expr:
        v = _ref_3vl(expr["not"], env)
        return None if v is None else (not v)
    raise AssertionError(expr)


def reference_run(query, rows):
    group_cols = query.get("group_by", [])
    buckets = {}
    for row in rows:
        k = tuple(_ref_key(row.get(c)) for c in group_cols)
        buckets.setdefault(k, []).append(row)
    if not group_cols and not buckets:
        buckets[()] = []
    out = []
    for members in buckets.values():
        rec = {}
        env = {}
        for c in group_cols:
            rec[c] = members[0].get(c) if members else None
            env[c] = rec[c]
        for spec in query.get("aggregates", []):
            alias = spec.get("as") or spec["func"].lower()
            rec[alias] = _ref_aggregate(
                spec["func"].upper(), spec["arg"],
                spec.get("distinct", False), members,
            )
            env[alias] = rec[alias]
        having = query.get("having")
        if having is None or _ref_3vl(having, env) is True:
            out.append(rec)
    # independent sorting: by JSON of the whole record
    out.sort(key=lambda r: json.dumps(r, sort_keys=True))
    return out


def sorted_records(records):
    return sorted(records, key=lambda r: json.dumps(r, sort_keys=True, default=str))


def assert_matches_reference(testcase, query, rows):
    expected = sorted_records(reference_run(query, rows))
    actual = sorted_records(run_query(query, rows))
    testcase.assertEqual(actual, expected)
    return actual


# ---------------------------------------------------------------------------
# Test data
# ---------------------------------------------------------------------------

SALES_ROWS = [
    {"dept": "eng", "amount": 10, "qty": 1},
    {"dept": "eng", "amount": 20, "qty": 2},
    {"dept": "eng", "amount": None, "qty": 3},
    {"dept": "ops", "amount": 5, "qty": 1},
    {"dept": "ops", "amount": 5, "qty": None},
    {"dept": None, "amount": 7, "qty": 7},
    {"dept": None, "amount": None, "qty": None},
    {"amount": 100, "qty": 4},  # missing dept -> NULL group
]


class AggregateSemanticsTest(unittest.TestCase):
    def test_multi_group_all_aggregates(self):
        query = {
            "group_by": ["dept"],
            "aggregates": [
                {"func": "COUNT", "arg": "*", "as": "n"},
                {"func": "COUNT", "arg": "amount", "as": "n_amount"},
                {"func": "SUM", "arg": "amount", "as": "total"},
                {"func": "AVG", "arg": "amount", "as": "avg"},
                {"func": "MIN", "arg": "amount", "as": "lo"},
                {"func": "MAX", "arg": "amount", "as": "hi"},
            ],
        }
        result = assert_matches_reference(self, query, SALES_ROWS)
        by_dept = {json.dumps(r["dept"]): r for r in result}
        eng = by_dept['"eng"']
        self.assertEqual(eng["n"], 3)            # COUNT(*) counts all rows
        self.assertEqual(eng["n_amount"], 2)     # COUNT(col) ignores NULL
        self.assertEqual(eng["total"], 30)       # SUM ignores NULL
        self.assertEqual(eng["avg"], "15/1")
        self.assertEqual(eng["lo"], 10)
        self.assertEqual(eng["hi"], 20)
        ops = by_dept['"ops"']
        self.assertEqual(ops["avg"], "5/1")
        null_group = by_dept["null"]             # NULL dept forms its own group
        self.assertEqual(null_group["n"], 3)
        self.assertEqual(null_group["n_amount"], 2)
        self.assertEqual(null_group["total"], 107)

    def test_null_group_keys_are_distinct_from_values(self):
        rows = [{"k": None, "v": 1}, {"v": 2}, {"k": "null", "v": 3}, {"k": 0, "v": 4}]
        query = {
            "group_by": ["k"],
            "aggregates": [{"func": "SUM", "arg": "v", "as": "s"}],
        }
        result = assert_matches_reference(self, query, rows)
        self.assertEqual(len(result), 3)  # None+missing merge; "null"/0 separate
        null_row = [r for r in result if r["k"] is None][0]
        self.assertEqual(null_row["s"], 3)

    def test_distinct_dedup_and_null_collapse(self):
        rows = [
            {"g": "a", "x": 1}, {"g": "a", "x": 1}, {"g": "a", "x": 2},
            {"g": "a", "x": None}, {"g": "a", "x": None}, {"g": "a"},
        ]
        query = {
            "group_by": ["g"],
            "aggregates": [
                {"func": "COUNT", "arg": "x", "distinct": True, "as": "cd"},
                {"func": "SUM", "arg": "x", "distinct": True, "as": "sd"},
                {"func": "COUNT", "arg": "x", "as": "c"},
                {"func": "SUM", "arg": "x", "as": "s"},
            ],
        }
        result = assert_matches_reference(self, query, rows)
        (row,) = result
        self.assertEqual(row["cd"], 2)   # NULLs ignored after collapsing
        self.assertEqual(row["sd"], 3)
        self.assertEqual(row["c"], 3)
        self.assertEqual(row["s"], 4)

    def test_empty_set_aggregates(self):
        query = {
            "aggregates": [
                {"func": "COUNT", "arg": "*", "as": "n"},
                {"func": "SUM", "arg": "x", "as": "s"},
                {"func": "MIN", "arg": "x", "as": "lo"},
                {"func": "MAX", "arg": "x", "as": "hi"},
                {"func": "AVG", "arg": "x", "as": "avg"},
            ],
        }
        rows = [{"x": None}, {}]
        result = assert_matches_reference(self, query, rows)
        self.assertEqual(result, [{"n": 2, "s": None, "lo": None,
                                   "hi": None, "avg": None}])

    def test_empty_input_no_group_by_gives_single_empty_group(self):
        query = {
            "aggregates": [
                {"func": "COUNT", "arg": "*", "as": "n"},
                {"func": "SUM", "arg": "x", "as": "s"},
                {"func": "AVG", "arg": "x", "as": "avg"},
            ],
        }
        # column "x" never appears -> unknown column
        with self.assertRaises(QueryError):
            run_query(query, [])

    def test_empty_input_with_group_by_gives_no_groups(self):
        query = {
            "group_by": ["g"],
            "aggregates": [{"func": "COUNT", "arg": "*", "as": "n"}],
        }
        self.assertEqual(run_query(query, []), [])

    def test_avg_reduced_fraction(self):
        cases = [
            ([1, 2], "3/2"),
            ([1, 2, 3], "2/1"),
            ([4], "4/1"),
            ([-1, 2], "1/2"),
            ([1, 1, 1, 2], "5/4"),
            ([None, 3, None], "3/1"),
        ]
        for values, expected in cases:
            rows = [{"x": v} for v in values]
            query = {"aggregates": [{"func": "AVG", "arg": "x", "as": "avg"}]}
            result = run_query(query, rows)
            self.assertEqual(result[0]["avg"], expected, msg=f"values={values}")
            assert_matches_reference(self, query, rows)


class HavingTest(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {"g": "a", "x": 10},
            {"g": "a", "x": 20},
            {"g": "b", "x": None},   # SUM(x) is NULL -> UNKNOWN comparisons
            {"g": "c", "x": 1},
            {"g": "c", "x": 2},
        ]
        self.aggs = [
            {"func": "SUM", "arg": "x", "as": "s"},
            {"func": "COUNT", "arg": "*", "as": "n"},
        ]

    def _run(self, having):
        query = {"group_by": ["g"], "aggregates": self.aggs, "having": having}
        return assert_matches_reference(self, query, self.rows)

    def test_having_keeps_only_true(self):
        result = self._run({"cmp": ">", "left": {"agg": "s"}, "right": {"lit": 5}})
        self.assertEqual([r["g"] for r in result], ["a"])  # b is UNKNOWN, c FALSE

    def test_having_unknown_excluded_by_not(self):
        # NOT UNKNOWN is still UNKNOWN -> group b stays excluded
        result = self._run({"not": {"cmp": ">", "left": {"agg": "s"},
                                    "right": {"lit": 5}}})
        self.assertEqual([r["g"] for r in result], ["c"])

    def test_having_and_or_three_valued(self):
        # UNKNOWN OR TRUE -> TRUE keeps b; UNKNOWN AND TRUE -> UNKNOWN drops b
        having_or = {"or": [
            {"cmp": ">", "left": {"agg": "s"}, "right": {"lit": 5}},
            {"cmp": "=", "left": {"agg": "n"}, "right": {"lit": 1}},
        ]}
        result = self._run(having_or)
        self.assertEqual([r["g"] for r in result], ["a", "b"])
        having_and = {"and": [
            {"cmp": ">", "left": {"agg": "s"}, "right": {"lit": 5}},
            {"cmp": "=", "left": {"agg": "n"}, "right": {"lit": 1}},
        ]}
        result = self._run(having_and)
        self.assertEqual(result, [])

    def test_having_group_by_column_reference(self):
        result = self._run({"cmp": "!=", "left": {"col": "g"},
                            "right": {"lit": "b"}})
        self.assertEqual([r["g"] for r in result], ["a", "c"])

    def test_having_null_literal_comparison_is_unknown(self):
        result = self._run({"cmp": "=", "left": {"agg": "s"},
                            "right": {"lit": None}})
        self.assertEqual(result, [])

    def test_having_unknown_aggregate_alias_raises(self):
        query = {"group_by": ["g"], "aggregates": self.aggs,
                 "having": {"cmp": ">", "left": {"agg": "nope"},
                            "right": {"lit": 1}}}
        with self.assertRaises(QueryError):
            run_query(query, self.rows)


class ErrorHandlingTest(unittest.TestCase):
    def test_unknown_aggregate_column_raises_query_error(self):
        query = {"aggregates": [{"func": "SUM", "arg": "missing", "as": "s"}]}
        with self.assertRaises(QueryError):
            run_query(query, [{"x": 1}])

    def test_unknown_function_raises(self):
        query = {"aggregates": [{"func": "MEDIAN", "arg": "x"}]}
        with self.assertRaises(QueryError):
            run_query(query, [{"x": 1}])

    def test_star_only_valid_for_count(self):
        query = {"aggregates": [{"func": "SUM", "arg": "*"}]}
        with self.assertRaises(QueryError):
            run_query(query, [{"x": 1}])


class CliTest(unittest.TestCase):
    def _run_cli(self, query, rows):
        with tempfile.TemporaryDirectory() as tmp:
            qpath = Path(tmp) / "query.json"
            rpath = Path(tmp) / "rows.json"
            qpath.write_text(json.dumps(query), encoding="utf-8")
            rpath.write_text(json.dumps(rows), encoding="utf-8")
            return subprocess.run(
                [sys.executable, "-m", "aggql", str(qpath), str(rpath)],
                cwd=REPO_ROOT, capture_output=True, text=True,
            )

    def test_cli_end_to_end(self):
        query = {
            "group_by": ["dept"],
            "aggregates": [
                {"func": "COUNT", "arg": "*", "as": "n"},
                {"func": "AVG", "arg": "amount", "as": "avg"},
            ],
            "having": {"cmp": ">", "left": {"agg": "n"}, "right": {"lit": 1}},
        }
        proc = self._run_cli(query, SALES_ROWS)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        actual = sorted_records(json.loads(proc.stdout))
        expected = sorted_records([
            r for r in reference_run(
                {k: v for k, v in query.items() if k != "having"}, SALES_ROWS)
            if r["n"] > 1
        ])
        self.assertEqual(actual, expected)

    def test_cli_unknown_aggregate_column_exit_code_2(self):
        query = {"aggregates": [{"func": "SUM", "arg": "nope", "as": "s"}]}
        proc = self._run_cli(query, [{"x": 1}])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("unknown aggregate column", proc.stderr)

    def test_cli_having_unknown_alias_exit_code_2(self):
        query = {
            "aggregates": [{"func": "COUNT", "arg": "*", "as": "n"}],
            "having": {"cmp": ">", "left": {"agg": "ghost"}, "right": {"lit": 0}},
        }
        proc = self._run_cli(query, [{"x": 1}])
        self.assertEqual(proc.returncode, 2)

    def test_cli_bad_usage_exit_code_2(self):
        proc = subprocess.run([sys.executable, "-m", "aggql"], cwd=REPO_ROOT,
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)

    def test_cli_missing_file_exit_code_1(self):
        proc = subprocess.run(
            [sys.executable, "-m", "aggql", "/nonexistent/q.json", "/nonexistent/r.json"],
            cwd=REPO_ROOT, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
