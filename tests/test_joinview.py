"""End-to-end tests for  using unittest.

The expected view is recomputed independently with plain nested loops
(reference_view) and compared against the CLI's stdout.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def reference_view(r_rows, s_rows):
    """Independent nested-loop recomputation of the join view.

    r_rows: list of (A, K); s_rows: list of (K, B). Bag semantics: every
    matching pair of physical rows contributes one join row. NULL keys
    (None) never join; NULL B contributes to count but not to sum.
    """
    grouped = {}
    for a_value, r_key in r_rows:
        if r_key is None:
            continue
        for s_key, b_value in s_rows:
            if s_key is None:
                continue
            if s_key != r_key:
                continue
            group_key = json.dumps(a_value, sort_keys=True)
            if group_key not in grouped:
                grouped[group_key] = {"A": a_value, "count": 0, "sum": 0}
            grouped[group_key]["count"] += 1
            if b_value is not None:
                grouped[group_key]["sum"] += b_value
    return [grouped[key] for key in sorted(grouped)]


class JoinViewCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = Path(self.tmp.name) / "state.json"
        self.script_path = Path(self.tmp.name) / "script.json"

    def run_cli(self, script, state=None):
        if state is not None:
            self.state_path.write_text(json.dumps(state), encoding="utf-8")
        self.script_path.write_text(json.dumps(script), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, "-m", "joinview", str(self.state_path), str(self.script_path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        committed = None
        if self.state_path.exists():
            committed = json.loads(self.state_path.read_text(encoding="utf-8"))
        return proc, committed

    # --- acceptance: nested savepoints -------------------------------------

    def test_inner_rollback_then_outer_commit(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
            {"op": "savepoint", "name": "inner"},
            {"op": "insert", "rel": "S", "K": "k", "B": 10},
            {"op": "rollback", "name": "inner"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(committed, {"R": [{"A": 1, "K": "k"}], "S": []})

    def test_outer_rollback_undoes_everything(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "outer"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
            {"op": "savepoint", "name": "inner"},
            {"op": "insert", "rel": "S", "K": "k", "B": 10},
            {"op": "rollback", "name": "outer"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(committed, {"R": [], "S": []})

    def test_illegal_delete_triggers_transaction_rollback(self):
        initial = {"R": [{"A": 9, "K": "z"}], "S": []}
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "S", "K": "z", "B": 1},
            {"op": "delete", "rel": "S", "K": "z", "B": 1},
            {"op": "delete", "rel": "S", "K": "z", "B": 1},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script, state=initial)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(committed, initial)

    # --- semantic errors: exit code 2, committed state unchanged -----------

    def test_delete_exceeding_multiplicity(self):
        initial = {"R": [{"A": 1, "K": "k"}], "S": []}
        script = [
            {"op": "begin"},
            {"op": "delete", "rel": "R", "A": 1, "K": "k"},
            {"op": "delete", "rel": "R", "A": 1, "K": "k"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script, state=initial)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(committed, initial)

    def test_duplicate_active_savepoint_name(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp"},
            {"op": "savepoint", "name": "sp"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)
        self.assertIsNone(committed)

    def test_commit_without_transaction(self):
        proc, committed = self.run_cli([{"op": "commit"}])
        self.assertEqual(proc.returncode, 2)
        self.assertIsNone(committed)

    def test_release_then_rollback_same_name_errors(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp"},
            {"op": "release", "name": "sp"},
            {"op": "rollback", "name": "sp"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)
        self.assertIsNone(committed)

    def test_release_removes_later_savepoints(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp1"},
            {"op": "savepoint", "name": "sp2"},
            {"op": "release", "name": "sp1"},
            {"op": "rollback", "name": "sp2"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 2)
        self.assertIsNone(committed)

    # --- savepoint stack details -------------------------------------------

    def test_rollback_keeps_the_savepoint(self):
        script = [
            {"op": "begin"},
            {"op": "savepoint", "name": "sp"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
            {"op": "rollback", "name": "sp"},
            {"op": "insert", "rel": "R", "A": 2, "K": "k"},
            {"op": "rollback", "name": "sp"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(committed, {"R": [], "S": []})

    def test_full_rollback_discards_transaction(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
            {"op": "rollback"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIsNone(committed)

    # --- persistence --------------------------------------------------------

    def test_uncommitted_script_does_not_persist(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIsNone(committed)

    def test_commit_persists_state(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(committed, {"R": [{"A": 1, "K": "k"}], "S": []})

    # --- view semantics ------------------------------------------------------

    def test_null_keys_never_join(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "A": 1, "K": None},
            {"op": "insert", "rel": "R", "A": 2, "K": "k"},
            {"op": "insert", "rel": "S", "K": None, "B": 5},
            {"op": "insert", "rel": "S", "K": "k", "B": 7},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        view = json.loads(proc.stdout)
        self.assertEqual(view, [{"A": 2, "count": 1, "sum": 7}])

    def test_view_matches_independent_nested_loop_recomputation(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "A": "x", "K": "k1"},
            {"op": "insert", "rel": "R", "A": "x", "K": "k1"},
            {"op": "insert", "rel": "R", "A": "x", "K": "k2"},
            {"op": "insert", "rel": "R", "A": "y", "K": "k1"},
            {"op": "insert", "rel": "R", "A": "y", "K": None},
            {"op": "insert", "rel": "S", "K": "k1", "B": 3},
            {"op": "insert", "rel": "S", "K": "k1", "B": 4},
            {"op": "insert", "rel": "S", "K": "k2", "B": None},
            {"op": "insert", "rel": "S", "K": None, "B": 100},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        view = json.loads(proc.stdout)
        r_rows = [(row["A"], row["K"]) for row in committed["R"]]
        s_rows = [(row["K"], row["B"]) for row in committed["S"]]
        self.assertEqual(view, reference_view(r_rows, s_rows))
        self.assertEqual(
            view,
            [
                {"A": "x", "count": 5, "sum": 14},
                {"A": "y", "count": 2, "sum": 7},
            ],
        )

    def test_bag_multiplicity_counts_duplicate_rows(self):
        script = [
            {"op": "begin"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
            {"op": "insert", "rel": "R", "A": 1, "K": "k"},
            {"op": "insert", "rel": "S", "K": "k", "B": 2},
            {"op": "insert", "rel": "S", "K": "k", "B": 2},
            {"op": "insert", "rel": "S", "K": "k", "B": 2},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        view = json.loads(proc.stdout)
        self.assertEqual(view, [{"A": 1, "count": 6, "sum": 12}])

    def test_delete_removes_one_occurrence(self):
        initial = {
            "R": [{"A": 1, "K": "k"}, {"A": 1, "K": "k"}],
            "S": [{"K": "k", "B": 5}],
        }
        script = [
            {"op": "begin"},
            {"op": "delete", "rel": "R", "A": 1, "K": "k"},
            {"op": "commit"},
        ]
        proc, committed = self.run_cli(script, state=initial)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(committed["R"], [{"A": 1, "K": "k"}])
        view = json.loads(proc.stdout)
        self.assertEqual(view, [{"A": 1, "count": 1, "sum": 5}])


if __name__ == "__main__":
    unittest.main()
