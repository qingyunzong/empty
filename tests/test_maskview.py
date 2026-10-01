"""Acceptance and differential tests for maskview.

Covers the acceptance criteria:
  A. Row filtering leaks no row count beyond the emitted rows themselves.
  B. Conflicting rules on one cell resolve to the strictest action (drop).
  C. Expressions referencing unknown columns fail with E_SCHEMA.
  D. Sorting by a dropped column fails with E_SCHEMA.
  E. Randomized tables (<=20 rows) and policies (<=50 rules) produce
     results identical to the per-cell reference evaluator.
"""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from maskview import PolicyError, reference_query, run_query  # noqa: E402
from maskview.engine import hash_value  # noqa: E402


def run_cli(data_obj, policy_obj, role):
    """Invoke the real CLI in a subprocess; returns (exit_code, stdout, stderr)."""
    with tempfile.TemporaryDirectory() as tmp:
        data_path = os.path.join(tmp, "data.json")
        policy_path = os.path.join(tmp, "policy.json")
        with open(data_path, "w", encoding="utf-8") as fh:
            json.dump(data_obj, fh)
        with open(policy_path, "w", encoding="utf-8") as fh:
            json.dump(policy_obj, fh)
        proc = subprocess.run(
            [sys.executable, "-m", "maskview", "query", data_path, policy_path, role],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
    return proc.returncode, proc.stdout, proc.stderr


EMPLOYEES = {
    "schema": [
        {"name": "id", "sensitivity": 0},
        {"name": "name", "sensitivity": 1},
        {"name": "dept", "sensitivity": 0},
        {"name": "salary", "sensitivity": 3},
        {"name": "ssn", "sensitivity": 3},
    ],
    "rows": [
        {"id": 1, "name": "ada", "dept": "eng", "salary": 120, "ssn": "111"},
        {"id": 2, "name": "bob", "dept": "ops", "salary": 90, "ssn": "222"},
        {"id": 3, "name": "cy", "dept": "eng", "salary": 110, "ssn": "333"},
        {"id": 4, "name": "di", "dept": "ops", "salary": 95, "ssn": "444"},
    ],
}


class RowFilteringTest(unittest.TestCase):
    """Acceptance A: invisible rows vanish; no existence/count leakage."""

    def test_filtered_rows_disappear_completely(self):
        policy = {"rules": [
            {"type": "row_filter", "role": "analyst", "expr": "dept == 'eng'"},
        ]}
        code, out, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 0, err)
        rows = json.loads(out)
        # The output is a bare array: the only count information available
        # is the number of emitted rows (no metadata, no null placeholders).
        self.assertIsInstance(rows, list)
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["id"] for r in rows], [1, 3])
        for row in rows:
            self.assertTrue(all(v is not None for v in row.values()))
            self.assertEqual(row["dept"], "eng")
        # No trace of the filtered-out rows anywhere in the payload.
        self.assertNotIn("bob", out)
        self.assertNotIn("di", out)
        self.assertNotIn("total", out)
        self.assertNotIn("filtered", out)

    def test_no_rows_match_gives_empty_array_not_null_rows(self):
        policy = {"rules": [
            {"type": "row_filter", "expr": "dept == 'legal'"},
        ]}
        code, out, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out), [])

    def test_multiple_filters_all_must_pass(self):
        policy = {"rules": [
            {"type": "row_filter", "expr": "dept == 'eng'"},
            {"type": "row_filter", "expr": "salary > 115"},
        ]}
        rows = run_query(EMPLOYEES, policy, "analyst")
        self.assertEqual([r["id"] for r in rows], [1])


class ConflictResolutionTest(unittest.TestCase):
    """Acceptance B: strictest action wins (drop > redact > hash > clear)."""

    def test_drop_beats_hash_on_same_column(self):
        policy = {"rules": [
            {"type": "mask", "role": "analyst", "column": "salary", "action": "hash"},
            {"type": "mask", "role": "analyst", "column": "salary", "action": "drop"},
        ]}
        code, out, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 0, err)
        rows = json.loads(out)
        self.assertTrue(rows)
        for row in rows:
            self.assertNotIn("salary", row)

    def test_redact_beats_hash_and_clear(self):
        policy = {"rules": [
            {"type": "mask", "column": "name", "action": "clear"},
            {"type": "mask", "column": "name", "action": "hash"},
            {"type": "mask", "column": "name", "action": "redact"},
        ]}
        rows = run_query(EMPLOYEES, policy, "analyst")
        self.assertTrue(all(r["name"] == "***" for r in rows))

    def test_hash_beats_clear_and_is_deterministic(self):
        policy = {"rules": [
            {"type": "mask", "column": "name", "action": "clear"},
            {"type": "mask", "column": "name", "action": "hash"},
        ]}
        rows = run_query(EMPLOYEES, policy, "analyst")
        self.assertEqual(rows[0]["name"], hash_value("ada"))
        self.assertEqual(rows[0]["name"], run_query(EMPLOYEES, policy, "analyst")[0]["name"])

    def test_drop_via_sensitivity_level(self):
        policy = {"rules": [
            {"type": "mask", "level": 3, "action": "drop"},
        ]}
        rows = run_query(EMPLOYEES, policy, "analyst")
        for row in rows:
            self.assertEqual(set(row), {"id", "name", "dept"})

    def test_rules_for_other_roles_are_ignored(self):
        policy = {"rules": [
            {"type": "mask", "role": "admin", "column": "salary", "action": "drop"},
        ]}
        rows = run_query(EMPLOYEES, policy, "analyst")
        self.assertIn("salary", rows[0])


class SchemaErrorTest(unittest.TestCase):
    """Acceptance C: unknown columns in expressions report E_SCHEMA."""

    def test_unknown_column_in_row_filter(self):
        policy = {"rules": [
            {"type": "row_filter", "expr": "department == 'eng'"},
        ]}
        code, out, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertEqual(json.loads(err)["error"], "E_SCHEMA")

    def test_unknown_column_in_mask_rule(self):
        policy = {"rules": [
            {"type": "mask", "column": "nope", "action": "hash"},
        ]}
        code, _, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(err)["error"], "E_SCHEMA")

    def test_unknown_column_in_when_clause(self):
        policy = {"rules": [
            {"type": "mask", "column": "salary", "action": "redact", "when": "ghost == 1"},
        ]}
        code, _, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(err)["error"], "E_SCHEMA")

    def test_unknown_is_not_treated_as_false(self):
        # Comparing against null yields UNKNOWN; the engine must not
        # silently filter the row out -- it raises E_EVAL instead.
        policy = {"rules": [
            {"type": "row_filter", "expr": "dept == null"},
        ]}
        code, _, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(err)["error"], "E_EVAL")


class SortTest(unittest.TestCase):
    """Acceptance D: dropped columns never participate in ordering."""

    def test_sort_by_dropped_column_is_e_schema(self):
        data = dict(EMPLOYEES, sort="salary")
        policy = {"rules": [
            {"type": "mask", "column": "salary", "action": "drop"},
        ]}
        code, out, err = run_cli(data, policy, "analyst")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertEqual(json.loads(err)["error"], "E_SCHEMA")

    def test_sort_by_unknown_column_is_e_schema(self):
        data = dict(EMPLOYEES, sort="nope")
        code, _, err = run_cli(data, {"rules": []}, "analyst")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(err)["error"], "E_SCHEMA")

    def test_sort_uses_original_values_and_schema_order(self):
        data = dict(EMPLOYEES, sort={"column": "salary", "desc": True})
        policy = {"rules": [
            {"type": "mask", "column": "salary", "action": "redact"},
        ]}
        rows = run_query(data, policy, "analyst")
        self.assertEqual([r["id"] for r in rows], [1, 3, 4, 2])
        self.assertTrue(all(r["salary"] == "***" for r in rows))


class ProjectionOrderTest(unittest.TestCase):
    """Requirement 5: output column order follows the schema, not the policy."""

    def test_schema_order_regardless_of_policy_order(self):
        policy = {"rules": [
            {"type": "mask", "column": "ssn", "action": "drop"},
            {"type": "mask", "column": "dept", "action": "hash"},
            {"type": "mask", "column": "salary", "action": "redact"},
            {"type": "mask", "column": "id", "action": "clear"},
        ]}
        code, out, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 0, err)
        rows = json.loads(out)
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(list(row.keys()), ["id", "name", "dept", "salary"])


# --------------------------------------------------------------------------
# Acceptance E: randomized differential testing against the reference.
# --------------------------------------------------------------------------

ROLES = ["analyst", "admin", "guest"]
ACTIONS = ["clear", "hash", "redact", "drop"]


def _random_value(rng, ctype, allow_null=True):
    if allow_null and rng.random() < 0.08:
        return None
    if ctype == "int":
        return rng.randint(-50, 50)
    if ctype == "str":
        return rng.choice(["alpha", "beta", "gamma", "delta", ""])
    return rng.choice([True, False])


def _literal(rng, ctype, allow_null=True):
    value = _random_value(rng, ctype, allow_null)
    if value is None:
        return "null"
    if ctype == "str":
        return json.dumps(value)
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _random_expr(rng, columns, depth=0, allow_null=True):
    if depth >= 2 or rng.random() < 0.55:
        col = rng.choice(columns)
        if col["type"] == "int":
            op = rng.choice(["==", "!=", "<", "<=", ">", ">="])
        else:
            op = rng.choice(["==", "!="])
        return "%s %s %s" % (col["name"], op, _literal(rng, col["type"], allow_null))
    combinators = ["and", "or"]
    if rng.random() < 0.25:
        return "not (%s)" % _random_expr(rng, columns, depth + 1, allow_null)
    return "(%s) %s (%s)" % (
        _random_expr(rng, columns, depth + 1, allow_null),
        rng.choice(combinators),
        _random_expr(rng, columns, depth + 1, allow_null),
    )


def _random_trial(rng):
    ncols = rng.randint(2, 6)
    columns = []
    for i in range(ncols):
        columns.append({
            "name": "c%d" % i,
            "type": rng.choice(["int", "str", "bool"]),
            "sensitivity": rng.randint(0, 3),
        })
    schema = [{"name": c["name"], "sensitivity": c["sensitivity"]} for c in columns]
    nulls_allowed = rng.random() < 0.5
    nrows = rng.randint(0, 20)
    rows = [
        {c["name"]: _random_value(rng, c["type"], nulls_allowed) for c in columns}
        for _ in range(nrows)
    ]
    data = {"schema": schema, "rows": rows}
    if rng.random() < 0.5:
        sort_col = rng.choice(columns)
        data["sort"] = {"column": sort_col["name"], "desc": rng.random() < 0.5}

    rules = []
    for _ in range(rng.randint(0, 50)):
        rule = {}
        if rng.random() < 0.8:
            rule["roles"] = rng.sample(ROLES, rng.randint(1, len(ROLES)))
        if rng.random() < 0.4:
            rule["type"] = "row_filter"
            rule["expr"] = _random_expr(rng, columns, allow_null=nulls_allowed)
        else:
            rule["type"] = "mask"
            if rng.random() < 0.6:
                rule["column"] = rng.choice(columns)["name"]
            else:
                rule["level"] = rng.randint(0, 3)
            rule["action"] = rng.choice(ACTIONS)
            if rule["action"] != "drop" and rng.random() < 0.3:
                rule["when"] = _random_expr(rng, columns, allow_null=nulls_allowed)
        rules.append(rule)
    policy = {"rules": rules}
    role = rng.choice(ROLES)
    return data, policy, role


class RandomizedConsistencyTest(unittest.TestCase):
    """Acceptance E: engine output == per-cell reference output."""

    def test_engine_matches_reference(self):
        rng = random.Random(20261001)
        trials = 400
        ok = err = 0
        for i in range(trials):
            data, policy, role = _random_trial(rng)
            try:
                expected = reference_query(data, policy, role)
                expected_err = None
            except PolicyError as exc:
                expected, expected_err = None, exc.code
            try:
                actual = run_query(data, policy, role)
                actual_err = None
            except PolicyError as exc:
                actual, actual_err = None, exc.code
            self.assertEqual(
                expected_err, actual_err,
                "trial %d: error mismatch (ref=%s engine=%s)\ndata=%s\npolicy=%s\nrole=%s"
                % (i, expected_err, actual_err, data, policy, role),
            )
            self.assertEqual(
                expected, actual,
                "trial %d: output mismatch\ndata=%s\npolicy=%s\nrole=%s"
                % (i, data, policy, role),
            )
            if expected_err is None:
                ok += 1
                # Invariants on every successful run.
                names = [c["name"] for c in data["schema"]]
                for row in actual:
                    self.assertEqual(list(row.keys()), [n for n in names if n in row])
            else:
                err += 1
        # Sanity: the generator must exercise both paths meaningfully.
        self.assertGreater(ok, 100)
        self.assertGreater(err, 0)


class HashAndRedactTest(unittest.TestCase):
    def test_hash_format_stable(self):
        self.assertTrue(hash_value("ada").startswith("sha256:"))
        self.assertEqual(hash_value({"b": 1, "a": 2}), hash_value({"a": 2, "b": 1}))

    def test_policy_error_exit_code_for_bad_policy(self):
        policy = {"rules": [{"type": "mask", "column": "id", "action": "vaporize"}]}
        code, _, err = run_cli(EMPLOYEES, policy, "analyst")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(err)["error"], "E_POLICY")

    def test_usage_error_exit_code(self):
        proc = subprocess.run(
            [sys.executable, "-m", "maskview"],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"], "E_USAGE")


if __name__ == "__main__":
    unittest.main()
