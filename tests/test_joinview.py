"""Tests for joinview.

The reference view here is computed with an independent nested-loop
implementation that shares no code with joinview.core.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def reference_view(state):
    """Independent nested-loop recomputation of the materialized view."""
    result = {}
    for r_row in state["R"]:
        a_val, r_key = r_row
        if r_key is None:
            continue
        for s_row in state["S"]:
            s_key, b_val = s_row
            if s_key is None:
                continue
            if s_key != r_key:
                continue
            marker = json.dumps(a_val, sort_keys=True)
            if marker not in result:
                result[marker] = {"A": a_val, "count": 0, "sum_b": 0}
            result[marker]["count"] += 1
            if b_val is not None:
                result[marker]["sum_b"] += b_val
    return sorted(
        result.values(),
        key=lambda e: (e["A"] is not None, json.dumps(e["A"], sort_keys=True)),
    )


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = os.path.join(self.tmp.name, "state.json")
        self.script_path = os.path.join(self.tmp.name, "script.json")

    def write_json(self, path, data):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)

    def run_cli(self, script, initial_state=None):
        if initial_state is not None:
            self.write_json(self.state_path, initial_state)
        self.write_json(self.script_path, script)
        proc = subprocess.run(
            [sys.executable, "-m", "joinview", self.state_path, self.script_path],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        view = None
        if proc.returncode == 0:
            view = json.loads(proc.stdout)["view"]
        return proc, view

    def read_state(self):
        if not os.path.exists(self.state_path):
            return {"R": [], "S": []}
        with open(self.state_path, encoding="utf-8") as fh:
            return json.load(fh)

    def assert_state_matches(self, expected):
        actual = self.read_state()
        for rel in ("R", "S"):
            self.assertEqual(
                sorted(map(lambda r: json.dumps(r, sort_keys=True), actual[rel])),
                sorted(map(lambda r: json.dumps(r, sort_keys=True), expected[rel])),
                f"relation {rel} differs",
            )

    # --- acceptance: inner rollback, then outer commit succeeds ---
    def test_inner_rollback_then_outer_commit(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "row": ["a", 1]},
            {"op": "savepoint", "name": "outer"},
            {"op": "savepoint", "name": "inner"},
            {"op": "insert", "rel": "S", "row": [1, 100]},
            {"op": "rollback", "name": "inner"},
            {"op": "insert", "rel": "S", "row": [1, 7]},
            {"op": "commit"},
        ]
        proc, view = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        state = self.read_state()
        self.assertEqual(state["R"], [["a", 1]])
        self.assertEqual(state["S"], [[1, 7]])
        self.assertEqual(view, reference_view(state))
        self.assertEqual(view, [{"A": "a", "count": 1, "sum_b": 7}])

    # --- acceptance: rollback to outer savepoint undoes everything after it ---
    def test_outer_rollback_undoes_all(self):
        initial = {"R": [["base", 9]], "S": [[9, 3]]}
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "outer"},
            {"op": "insert", "rel": "R", "row": ["x", 1]},
            {"op": "savepoint", "name": "inner"},
            {"op": "insert", "rel": "S", "row": [1, 5]},
            {"op": "delete", "rel": "R", "row": ["base", 9]},
            {"op": "rollback", "name": "outer"},
            {"op": "commit"},
        ]
        proc, view = self.run_cli(script, initial)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assert_state_matches(initial)
        self.assertEqual(view, reference_view(initial))

    # --- acceptance: full rollback discards the whole transaction ---
    def test_full_rollback_discards_transaction(self):
        initial = {"R": [["a", 1]], "S": [[1, 2]]}
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "row": ["b", 1]},
            {"op": "delete", "rel": "S", "row": [1, 2]},
            {"op": "rollback"},
        ]
        proc, view = self.run_cli(script, initial)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assert_state_matches(initial)
        self.assertEqual(view, reference_view(initial))

    # --- acceptance: illegal delete aborts with exit 2 and rolls back ---
    def test_illegal_delete_rolls_back_transaction(self):
        initial = {"R": [["a", 1]], "S": [[1, 2]]}
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "row": ["b", 2]},
            {"op": "delete", "rel": "S", "row": [1, 2]},
            {"op": "delete", "rel": "S", "row": [1, 2]},  # exceeds multiplicity
            {"op": "commit"},
        ]
        proc, _ = self.run_cli(script, initial)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("multiplicity", proc.stderr)
        self.assert_state_matches(initial)

    def test_delete_absent_row_is_error(self):
        script = [
            {"op": "begin"},
            {"op": "delete", "rel": "R", "row": ["ghost", 0]},
        ]
        proc, _ = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(self.state_path))

    # --- savepoint stack semantics ---
    def test_release_then_rollback_is_error(self):
        initial = {"R": [["a", 1]], "S": []}
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp"},
            {"op": "release", "name": "sp"},
            {"op": "rollback", "name": "sp"},
        ]
        proc, _ = self.run_cli(script, initial)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("savepoint", proc.stderr)
        self.assert_state_matches(initial)

    def test_rollback_to_savepoint_destroys_later_savepoints(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "one"},
            {"op": "savepoint", "name": "two"},
            {"op": "rollback", "name": "one"},
            {"op": "rollback", "name": "two"},  # 'two' no longer active
        ]
        proc, _ = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)

    def test_rollback_keeps_named_savepoint_reusable(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp"},
            {"op": "insert", "rel": "R", "row": ["a", 1]},
            {"op": "rollback", "name": "sp"},
            {"op": "insert", "rel": "R", "row": ["b", 2]},
            {"op": "rollback", "name": "sp"},  # still active after rollback
            {"op": "insert", "rel": "S", "row": [3, 4]},
            {"op": "commit"},
        ]
        proc, _ = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assert_state_matches({"R": [], "S": [[3, 4]]})

    def test_release_removes_later_savepoints_too(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "one"},
            {"op": "savepoint", "name": "two"},
            {"op": "release", "name": "one"},
            {"op": "rollback", "name": "two"},
        ]
        proc, _ = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)

    def test_duplicate_active_savepoint_is_error(self):
        initial = {"R": [], "S": []}
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp"},
            {"op": "savepoint", "name": "sp"},
        ]
        proc, _ = self.run_cli(script, initial)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("duplicate", proc.stderr)
        self.assert_state_matches(initial)

    def test_savepoint_name_reusable_after_release(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp"},
            {"op": "release", "name": "sp"},
            {"op": "savepoint", "name": "sp"},
            {"op": "insert", "rel": "R", "row": ["a", 1]},
            {"op": "rollback", "name": "sp"},
            {"op": "commit"},
        ]
        proc, _ = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assert_state_matches({"R": [], "S": []})

    # --- transaction lifecycle errors ---
    def test_commit_without_transaction_is_error(self):
        initial = {"R": [["a", 1]], "S": []}
        proc, _ = self.run_cli([{"op": "commit"}], initial)
        self.assertEqual(proc.returncode, 2)
        self.assert_state_matches(initial)

    def test_nested_begin_is_error(self):
        script = [{"op": "begin"}, {"op": "begin"}]
        proc, _ = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)

    def test_unknown_operation_is_error(self):
        script = [{"op": "begin"}, {"op": "vacuum"}]
        proc, _ = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)

    # --- uncommitted scripts never touch persistent state ---
    def test_uncommitted_script_leaves_state_untouched(self):
        initial = {"R": [["a", 1]], "S": [[1, 5]]}
        with open(self.state_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(initial))
        with open(self.state_path, encoding="utf-8") as fh:
            before = fh.read()
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "row": ["b", 1]},
            {"op": "delete", "rel": "S", "row": [1, 5]},
        ]
        proc, view = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(self.state_path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), before)
        self.assertEqual(view, reference_view(initial))

    def test_multiple_transactions_in_one_script(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "row": ["a", 1]},
            {"op": "commit"},
            {"op": "begin"},
            {"op": "insert", "rel": "S", "row": [1, 10]},
            {"op": "commit"},
        ]
        proc, view = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(view, [{"A": "a", "count": 1, "sum_b": 10}])

    # --- NULL keys never join ---
    def test_null_keys_do_not_join(self):
        initial = {
            "R": [["a", None], ["b", 1], ["c", None]],
            "S": [[None, 10], [1, 5], [None, 20]],
        }
        proc, view = self.run_cli([], initial)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(view, [{"A": "b", "count": 1, "sum_b": 5}])
        self.assertEqual(view, reference_view(initial))

    # --- bag semantics: multiplicities multiply join rows ---
    def test_bag_multiplicity(self):
        initial = {
            "R": [["a", 1], ["a", 1], ["b", 1], ["a", 2]],
            "S": [[1, 3], [1, 3], [2, 4]],
        }
        proc, view = self.run_cli([], initial)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            view,
            [
                {"A": "a", "count": 5, "sum_b": 16},
                {"A": "b", "count": 2, "sum_b": 6},
            ],
        )
        self.assertEqual(view, reference_view(initial))

    def test_delete_respects_multiplicity(self):
        initial = {"R": [["a", 1], ["a", 1]], "S": [[1, 2]]}
        script = [
            {"op": "begin"},
            {"op": "delete", "rel": "R", "row": ["a", 1]},
            {"op": "commit"},
        ]
        proc, view = self.run_cli(script, initial)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(view, [{"A": "a", "count": 1, "sum_b": 2}])

    # --- end-to-end: committed script persists, view matches reference ---
    def test_committed_script_persists_and_matches_reference(self):
        initial = {
            "R": [["a", 1], ["a", 2], ["b", None], ["c", 3]],
            "S": [[1, 10], [2, 20], [None, 99], [3, 30], [3, 30]],
        }
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "row": ["a", 3]},
            {"op": "savepoint", "name": "sp1"},
            {"op": "delete", "rel": "S", "row": [3, 30]},
            {"op": "insert", "rel": "S", "row": [1, 1]},
            {"op": "savepoint", "name": "sp2"},
            {"op": "delete", "rel": "R", "row": ["a", 1]},
            {"op": "rollback", "name": "sp2"},
            {"op": "release", "name": "sp1"},
            {"op": "commit"},
        ]
        proc, view = self.run_cli(script, initial)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        state = self.read_state()
        self.assertEqual(view, reference_view(state))
        expected_state = {
            "R": [["a", 1], ["a", 2], ["b", None], ["c", 3], ["a", 3]],
            "S": [[1, 10], [2, 20], [None, 99], [3, 30], [1, 1]],
        }
        self.assert_state_matches(expected_state)

    def test_usage_error_exit_code(self):
        proc = subprocess.run(
            [sys.executable, "-m", "joinview"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
