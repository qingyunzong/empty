import json
import os
import subprocess
import sys
import tempfile
import unittest

from maskview import MaskView, PolicyError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_data(rows=None):
    return {
        "columns": ["id", "name", "dept", "salary"],
        "rows": rows if rows is not None else [
            {"id": 1, "name": "ada", "dept": "eng", "salary": 100},
            {"id": 2, "name": "bob", "dept": "ops", "salary": 90},
            {"id": 3, "name": "cy", "dept": "eng", "salary": None},
        ],
    }


def make_policy(role_rules=None, filters=None, sensitivity=None):
    role = {}
    if filters is not None:
        role["row_filters"] = filters
    if role_rules is not None:
        role["column_rules"] = role_rules
    policy = {"roles": {"analyst": role}}
    if sensitivity:
        policy["sensitivity"] = sensitivity
    return policy


class RowFilterTests(unittest.TestCase):
    """Acceptance A: invisible rows vanish; no existence leakage."""

    def test_denied_rows_disappear_completely(self):
        policy = make_policy(filters=[{"when": "dept == 'eng'", "effect": "deny"}])
        view = MaskView(make_data(), policy)
        result = view.query("analyst")
        self.assertEqual([r["id"] for r in result], [2])
        # No null placeholder rows, no hidden-row metadata.
        for row in result:
            self.assertNotEqual(row, {})
            self.assertTrue(all(v is not None or k == "salary" for k, v in row.items()))
        self.assertNotIn("hidden", json.dumps(result).lower())

    def test_count_interface_matches_visible_rows(self):
        policy = make_policy(filters=[{"when": "salary > 95", "effect": "allow"}])
        view = MaskView(make_data(), policy)
        self.assertEqual(view.count("analyst"), len(view.query("analyst")))
        self.assertEqual(view.count("analyst"), 1)

    def test_default_allow_when_no_filters(self):
        view = MaskView(make_data(), make_policy())
        self.assertEqual(len(view.query("analyst")), 3)


class ThreeValuedLogicTests(unittest.TestCase):
    """UNKNOWN must not be silently treated as false."""

    def test_not_unknown_is_unknown_and_hides_row(self):
        # salary is NULL for id=3: NOT (salary > 95) is UNKNOWN, not TRUE.
        policy = make_policy(filters=[{"when": "not (salary > 95)", "effect": "allow"}])
        view = MaskView(make_data(), policy)
        self.assertEqual([r["id"] for r in view.query("analyst")], [2])

    def test_true_or_unknown_is_true(self):
        policy = make_policy(
            filters=[{"when": "dept == 'eng' or salary > 95", "effect": "allow"}]
        )
        view = MaskView(make_data(), policy)
        # id=3: dept matches so UNKNOWN comparison does not hide the row.
        self.assertEqual([r["id"] for r in view.query("analyst")], [1, 3])

    def test_is_null_expression(self):
        policy = make_policy(filters=[{"when": "salary is null", "effect": "allow"}])
        view = MaskView(make_data(), policy)
        self.assertEqual([r["id"] for r in view.query("analyst")], [3])


class ColumnMaskingTests(unittest.TestCase):
    """Acceptance B: strictest action wins per cell (drop>redact>hash>clear)."""

    def test_drop_wins_over_redact_and_hash(self):
        rules = [
            {"column": "salary", "action": "hash"},
            {"column": "salary", "action": "drop"},
            {"column": "salary", "action": "redact"},
        ]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        for row in view.query("analyst"):
            self.assertNotIn("salary", row)

    def test_redact_wins_over_hash_and_clear(self):
        rules = [
            {"column": "name", "action": "clear"},
            {"column": "name", "action": "hash"},
            {"column": "name", "action": "redact"},
        ]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        self.assertTrue(all(r["name"] == "***" for r in view.query("analyst")))

    def test_hash_is_deterministic_and_beats_clear(self):
        rules = [{"column": "name", "action": "clear"},
                 {"column": "name", "action": "hash"}]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        rows = view.query("analyst")
        self.assertTrue(all(r["name"].startswith("sha256:") for r in rows))
        again = MaskView(make_data(), make_policy(role_rules=rules)).query("analyst")
        self.assertEqual(rows, again)

    def test_conditional_rule_applies_per_cell(self):
        rules = [{"column": "salary", "action": "redact", "when": "dept == 'eng'"}]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        rows = view.query("analyst")
        self.assertEqual(rows[0]["salary"], "***")
        self.assertEqual(rows[1]["salary"], 90)
        self.assertEqual(rows[2]["salary"], "***")

    def test_sensitivity_selector(self):
        rules = [{"sensitivity_at_least": "high", "action": "redact"}]
        policy = make_policy(role_rules=rules, sensitivity={"salary": "high", "name": "low"})
        view = MaskView(make_data(), policy)
        rows = view.query("analyst")
        self.assertEqual(rows[0]["salary"], "***")
        self.assertEqual(rows[0]["name"], "ada")

    def test_output_column_order_follows_schema_not_policy(self):
        rules = [
            {"column": "salary", "action": "hash"},
            {"column": "name", "action": "redact"},
            {"column": "id", "action": "clear"},
        ]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        for row in view.query("analyst"):
            self.assertEqual(list(row.keys()), ["id", "name", "dept", "salary"])


class SchemaErrorTests(unittest.TestCase):
    """Acceptance C/D: unknown columns and dropped sort keys -> E_SCHEMA."""

    def assert_code(self, code, fn, *args, **kwargs):
        with self.assertRaises(PolicyError) as ctx:
            fn(*args, **kwargs)
        self.assertEqual(ctx.exception.code, code)

    def test_unknown_column_in_row_filter(self):
        policy = make_policy(filters=[{"when": "age > 30", "effect": "deny"}])
        self.assert_code("E_SCHEMA", MaskView, make_data(), policy)

    def test_unknown_column_in_rule_condition(self):
        rules = [{"column": "salary", "action": "hash", "when": "age > 30"}]
        self.assert_code("E_SCHEMA", MaskView, make_data(), make_policy(role_rules=rules))

    def test_unknown_column_in_rule_target(self):
        rules = [{"column": "ssn", "action": "drop"}]
        self.assert_code("E_SCHEMA", MaskView, make_data(), make_policy(role_rules=rules))

    def test_unknown_column_in_sensitivity_map(self):
        policy = make_policy(sensitivity={"ssn": "high"})
        self.assert_code("E_SCHEMA", MaskView, make_data(), policy)

    def test_sort_by_dropped_column_unconditional(self):
        rules = [{"column": "salary", "action": "drop"}]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        self.assert_code("E_SCHEMA", view.query, "analyst", sort_by="salary")

    def test_sort_by_conditionally_dropped_column(self):
        rules = [{"column": "salary", "action": "drop", "when": "dept == 'eng'"}]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        self.assert_code("E_SCHEMA", view.query, "analyst", sort_by="salary")

    def test_sort_by_unknown_column(self):
        view = MaskView(make_data(), make_policy())
        self.assert_code("E_SCHEMA", view.query, "analyst", sort_by="age")

    def test_sort_by_kept_column_works(self):
        rules = [{"column": "salary", "action": "hash"}]
        view = MaskView(make_data(), make_policy(role_rules=rules))
        rows = view.query("analyst", sort_by="id", descending=True)
        self.assertEqual([r["id"] for r in rows], [3, 2, 1])


class CliTests(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "maskview", *argv],
            cwd=ROOT, capture_output=True, text=True,
        )

    def write_tmp(self, obj):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as handle:
            json.dump(obj, handle)
        self.addCleanup(os.unlink, path)
        return path

    def test_query_outputs_json_rows(self):
        data = self.write_tmp(make_data())
        policy = self.write_tmp(make_policy(
            filters=[{"when": "dept == 'eng'", "effect": "allow"}],
            role_rules=[{"column": "salary", "action": "drop"}],
        ))
        proc = self.run_cli("query", data, policy, "analyst")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = json.loads(proc.stdout)
        self.assertEqual([r["id"] for r in rows], [1, 3])
        self.assertTrue(all("salary" not in r for r in rows))

    def test_count_interface(self):
        data = self.write_tmp(make_data())
        policy = self.write_tmp(make_policy(
            filters=[{"when": "dept == 'eng'", "effect": "allow"}]))
        proc = self.run_cli("count", data, policy, "analyst")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"count": 2})

    def test_policy_error_exits_2_with_code(self):
        data = self.write_tmp(make_data())
        policy = self.write_tmp(make_policy(
            filters=[{"when": "nope == 1", "effect": "deny"}]))
        proc = self.run_cli("query", data, policy, "analyst")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "E_SCHEMA")

    def test_sort_by_dropped_column_cli(self):
        data = self.write_tmp(make_data())
        policy = self.write_tmp(make_policy(
            role_rules=[{"column": "salary", "action": "drop"}]))
        proc = self.run_cli("query", data, policy, "analyst", "--sort-by", "salary")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "E_SCHEMA")


if __name__ == "__main__":
    unittest.main()
