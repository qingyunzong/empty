"""Tests for aggql.

Includes an independent reference implementation (dict-based regrouping and
its own sorting) used to cross-check the engine, plus the acceptance cases:
multi-group aggregation, NULL grouping / NULL dedup / empty groups, and
HAVING three-valued logic excluding UNKNOWN.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aggql import compute  # noqa: E402


# ---------------------------------------------------------------------------
# Independent reference implementation (written separately from aggql core).
# ---------------------------------------------------------------------------

def ref_aggregate(func, arg, distinct, rows):
    if func == "COUNT" and arg == "*":
        return len(rows)
    vals = [r[arg] for r in rows if r.get(arg) is not None]
    if distinct:
        vals = list(dict.fromkeys(vals))
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
        f = Fraction(sum(vals), len(vals))
        return f"{f.numerator}/{f.denominator}"
    raise AssertionError(func)


def ref_compute(rows, group_by, aggregates):
    """Reference: regroup with a plain dict, recompute every aggregate."""
    buckets = {}
    for row in rows:
        key = tuple(row.get(c) for c in group_by)
        buckets.setdefault(key, []).append(row)
    if not group_by and not buckets:
        buckets[()] = []
    out = []
    for key, members in buckets.items():
        rec = dict(zip(group_by, key))
        for spec in aggregates:
            rec[spec["as"]] = ref_aggregate(
                spec["func"], spec.get("arg", "*"),
                bool(spec.get("distinct")), members)
        out.append(rec)
    return out


def canon(rows):
    """Independent canonical ordering for comparison."""
    return sorted(json.dumps(r, sort_keys=True) for r in rows)


# ---------------------------------------------------------------------------
# Acceptance case 1: plain multi-group aggregation.
# ---------------------------------------------------------------------------

class TestMultiGroup(unittest.TestCase):
    ROWS = [
        {"dept": "eng", "salary": 100, "bonus": 10},
        {"dept": "eng", "salary": 200, "bonus": 20},
        {"dept": "eng", "salary": 300, "bonus": 30},
        {"dept": "ops", "salary": 50, "bonus": 5},
        {"dept": "ops", "salary": 70, "bonus": 7},
    ]
    AGGS = [
        {"func": "COUNT", "arg": "*", "as": "cnt"},
        {"func": "COUNT", "arg": "salary", "as": "cnt_s"},
        {"func": "SUM", "arg": "salary", "as": "total"},
        {"func": "AVG", "arg": "salary", "as": "avg"},
        {"func": "MIN", "arg": "salary", "as": "lo"},
        {"func": "MAX", "arg": "salary", "as": "hi"},
    ]

    def test_groups(self):
        got = compute(self.ROWS, {"group_by": ["dept"], "aggregates": self.AGGS})
        want = ref_compute(self.ROWS, ["dept"], self.AGGS)
        self.assertEqual(canon(got), canon(want))
        self.assertEqual(canon(got), canon([
            {"dept": "eng", "cnt": 3, "cnt_s": 3, "total": 600,
             "avg": "200/1", "lo": 100, "hi": 300},
            {"dept": "ops", "cnt": 2, "cnt_s": 2, "total": 120,
             "avg": "60/1", "lo": 50, "hi": 70},
        ]))

    def test_avg_reduced_fraction(self):
        rows = [{"g": 1, "x": 1}, {"g": 1, "x": 2}]
        got = compute(rows, {"group_by": ["g"],
                             "aggregates": [{"func": "AVG", "arg": "x", "as": "a"}]})
        self.assertEqual(got, [{"g": 1, "a": "3/2"}])

    def test_no_group_by_single_group(self):
        got = compute(self.ROWS, {"aggregates": self.AGGS})
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["cnt"], 5)
        self.assertEqual(got[0]["total"], 720)
        self.assertEqual(got[0]["avg"], "144/1")


# ---------------------------------------------------------------------------
# Acceptance case 2: NULL grouping, NULL dedup, empty groups.
# ---------------------------------------------------------------------------

class TestNullSemantics(unittest.TestCase):
    ROWS = [
        {"dept": "eng", "x": 1},
        {"dept": None, "x": None},
        {"dept": None, "x": None},
        {"dept": None, "x": 5},
        {"dept": "eng", "x": None},
        {"dept": "eng", "x": 1},
    ]

    def test_null_forms_own_group(self):
        got = compute(self.ROWS, {
            "group_by": ["dept"],
            "aggregates": [
                {"func": "COUNT", "arg": "*", "as": "cnt"},
                {"func": "COUNT", "arg": "x", "as": "cnt_x"},
                {"func": "COUNT", "arg": "x", "distinct": True, "as": "cnt_dx"},
                {"func": "SUM", "arg": "x", "as": "s"},
                {"func": "AVG", "arg": "x", "as": "a"},
                {"func": "MIN", "arg": "x", "as": "lo"},
                {"func": "MAX", "arg": "x", "as": "hi"},
            ],
        })
        want = ref_compute(self.ROWS, ["dept"], [
            {"func": "COUNT", "arg": "*", "as": "cnt"},
            {"func": "COUNT", "arg": "x", "as": "cnt_x"},
            {"func": "COUNT", "arg": "x", "distinct": True, "as": "cnt_dx"},
            {"func": "SUM", "arg": "x", "as": "s"},
            {"func": "AVG", "arg": "x", "as": "a"},
            {"func": "MIN", "arg": "x", "as": "lo"},
            {"func": "MAX", "arg": "x", "as": "hi"},
        ])
        self.assertEqual(canon(got), canon(want))
        # NULL dept group: 3 rows, one non-NULL x (5).
        null_group = next(r for r in got if r["dept"] is None)
        self.assertEqual(null_group, {"dept": None, "cnt": 3, "cnt_x": 1,
                                      "cnt_dx": 1, "s": 5, "a": "5/1",
                                      "lo": 5, "hi": 5})
        # eng group: COUNT(*) counts NULL rows, COUNT(x)/DISTINCT ignore NULLs.
        eng = next(r for r in got if r["dept"] == "eng")
        self.assertEqual(eng, {"dept": "eng", "cnt": 3, "cnt_x": 2,
                               "cnt_dx": 1, "s": 2, "a": "1/1",
                               "lo": 1, "hi": 1})

    def test_all_null_group_aggregates(self):
        rows = [{"g": None, "x": None}, {"g": None, "x": None}]
        got = compute(rows, {
            "group_by": ["g"],
            "aggregates": [
                {"func": "COUNT", "arg": "*", "as": "cnt"},
                {"func": "COUNT", "arg": "x", "as": "cnt_x"},
                {"func": "SUM", "arg": "x", "as": "s"},
                {"func": "AVG", "arg": "x", "as": "a"},
                {"func": "MIN", "arg": "x", "as": "lo"},
                {"func": "MAX", "arg": "x", "as": "hi"},
            ],
        })
        self.assertEqual(got, [{"g": None, "cnt": 2, "cnt_x": 0, "s": None,
                                "a": None, "lo": None, "hi": None}])

    def test_empty_input_no_group_by(self):
        aggs = [
            {"func": "COUNT", "arg": "*", "as": "cnt"},
            {"func": "COUNT", "arg": "x", "as": "cnt_x"},
            {"func": "SUM", "arg": "x", "as": "s"},
            {"func": "AVG", "arg": "x", "as": "a"},
            {"func": "MIN", "arg": "x", "as": "lo"},
            {"func": "MAX", "arg": "x", "as": "hi"},
        ]
        got = compute([], {"aggregates": aggs})
        self.assertEqual(got, [{"cnt": 0, "cnt_x": 0, "s": None,
                                "a": None, "lo": None, "hi": None}])

    def test_empty_input_with_group_by(self):
        got = compute([], {"group_by": ["g"],
                           "aggregates": [{"func": "COUNT", "arg": "*", "as": "c"}]})
        self.assertEqual(got, [])


# ---------------------------------------------------------------------------
# Acceptance case 3: HAVING three-valued logic keeps only TRUE.
# ---------------------------------------------------------------------------

class TestHaving(unittest.TestCase):
    ROWS = [
        {"dept": "eng", "x": 10},
        {"dept": "eng", "x": 20},
        {"dept": "ops", "x": 1},
        {"dept": "hr", "x": None},   # SUM(x) is NULL -> comparisons UNKNOWN
    ]
    AGGS = [{"func": "SUM", "arg": "x", "as": "s"},
            {"func": "COUNT", "arg": "*", "as": "cnt"}]

    def run_having(self, having):
        return compute(self.ROWS, {"group_by": ["dept"],
                                   "aggregates": self.AGGS,
                                   "having": having})

    def test_unknown_excluded(self):
        got = self.run_having({"op": "GT", "left": {"alias": "s"},
                               "right": {"const": 5}})
        # eng: 30 > 5 TRUE; ops: 1 > 5 FALSE; hr: NULL > 5 UNKNOWN -> excluded.
        self.assertEqual([r["dept"] for r in got], ["eng"])

    def test_not_unknown_stays_unknown(self):
        got = self.run_having({"op": "NOT",
                               "arg": {"op": "GT", "left": {"alias": "s"},
                                       "right": {"const": 5}}})
        # eng: NOT TRUE = FALSE; ops: NOT FALSE = TRUE; hr: NOT UNKNOWN = UNKNOWN.
        self.assertEqual([r["dept"] for r in got], ["ops"])

    def test_and_or_three_valued(self):
        # TRUE AND UNKNOWN -> UNKNOWN (hr excluded);
        # FALSE OR UNKNOWN -> UNKNOWN; TRUE OR UNKNOWN -> TRUE.
        having = {"op": "OR", "args": [
            {"op": "GT", "left": {"alias": "s"}, "right": {"const": 100}},
            {"op": "EQ", "left": {"alias": "cnt"}, "right": {"const": 1}},
        ]}
        got = self.run_having(having)
        # eng: F OR F = F; ops: F OR T = T; hr: UNKNOWN OR T = T.
        self.assertEqual([r["dept"] for r in got], ["hr", "ops"])

    def test_is_null_and_inline_agg(self):
        having = {"op": "IS_NULL",
                  "arg": {"agg": {"func": "SUM", "arg": "x"}}}
        got = self.run_having(having)
        self.assertEqual([r["dept"] for r in got], ["hr"])

    def test_having_on_group_col_and_const(self):
        having = {"op": "AND", "args": [
            {"op": "NE", "left": {"col": "dept"}, "right": {"const": "ops"}},
            {"op": "LE", "left": {"alias": "cnt"}, "right": {"const": 2}},
        ]}
        got = self.run_having(having)
        self.assertEqual(sorted(r["dept"] for r in got), ["eng", "hr"])


# ---------------------------------------------------------------------------
# Cross-check against the independent reference on a larger mixed dataset.
# ---------------------------------------------------------------------------

class TestReferenceCrossCheck(unittest.TestCase):
    def test_mixed_dataset(self):
        rows = []
        for i in range(60):
            rows.append({
                "g1": [None, "a", "b"][i % 3],
                "g2": i % 2,
                "v": None if i % 5 == 0 else i,
                "w": None if i % 7 == 0 else (i * 3) % 11,
            })
        aggregates = [
            {"func": "COUNT", "arg": "*", "as": "cnt"},
            {"func": "COUNT", "arg": "v", "as": "cnt_v"},
            {"func": "COUNT", "arg": "v", "distinct": True, "as": "cnt_dv"},
            {"func": "SUM", "arg": "v", "as": "sum_v"},
            {"func": "SUM", "arg": "w", "distinct": True, "as": "sum_dw"},
            {"func": "AVG", "arg": "v", "as": "avg_v"},
            {"func": "AVG", "arg": "w", "distinct": True, "as": "avg_dw"},
            {"func": "MIN", "arg": "v", "as": "min_v"},
            {"func": "MAX", "arg": "w", "as": "max_w"},
        ]
        got = compute(rows, {"group_by": ["g1", "g2"], "aggregates": aggregates})
        want = ref_compute(rows, ["g1", "g2"], aggregates)
        self.assertEqual(canon(got), canon(want))


# ---------------------------------------------------------------------------
# CLI end-to-end: python -m aggql query.json rows.json
# ---------------------------------------------------------------------------

class TestCli(unittest.TestCase):
    def run_cli(self, query, rows):
        with tempfile.TemporaryDirectory() as tmp:
            qpath = os.path.join(tmp, "query.json")
            rpath = os.path.join(tmp, "rows.json")
            with open(qpath, "w", encoding="utf-8") as fh:
                json.dump(query, fh)
            with open(rpath, "w", encoding="utf-8") as fh:
                json.dump(rows, fh)
            root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            return subprocess.run(
                [sys.executable, "-m", "aggql", qpath, rpath],
                capture_output=True, text=True, cwd=root)

    def test_cli_success(self):
        proc = self.run_cli(
            {"group_by": ["d"],
             "aggregates": [{"func": "AVG", "arg": "x", "as": "a"}]},
            [{"d": "p", "x": 1}, {"d": "p", "x": 2}, {"d": "q", "x": 9}])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        got = json.loads(proc.stdout)
        self.assertEqual(canon(got), canon([
            {"d": "p", "a": "3/2"}, {"d": "q", "a": "9/1"}]))

    def test_cli_unknown_aggregate_column_exit_2(self):
        proc = self.run_cli(
            {"aggregates": [{"func": "SUM", "arg": "nope", "as": "s"}]},
            [{"x": 1}])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("unknown aggregate column", proc.stderr)

    def test_cli_unknown_group_by_column_exit_2(self):
        proc = self.run_cli({"group_by": ["nope"], "aggregates": []},
                            [{"x": 1}])
        self.assertEqual(proc.returncode, 2)

    def test_cli_unknown_having_alias_exit_2(self):
        proc = self.run_cli(
            {"aggregates": [{"func": "COUNT", "arg": "*", "as": "c"}],
             "having": {"op": "GT", "left": {"alias": "nope"},
                        "right": {"const": 0}}},
            [{"x": 1}])
        self.assertEqual(proc.returncode, 2)

    def test_cli_usage_exit_2(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        proc = subprocess.run([sys.executable, "-m", "aggql"],
                              capture_output=True, text=True, cwd=root)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
