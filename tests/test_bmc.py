"""Acceptance and unit tests for the bmc bounded model checker."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bmc.engine import ERROR, SAFE_BOUNDED, VIOLATION, check  # noqa: E402
from bmc.model import load_model  # noqa: E402


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "bmc", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def write_model(tmp, model) -> Path:
    path = Path(tmp) / "model.json"
    if isinstance(model, str):
        path.write_text(model, encoding="utf-8")
    else:
        path.write_text(json.dumps(model), encoding="utf-8")
    return path


def reference_bfs_min_violation_depth():
    """Independent enumeration BFS for the 3-process broken mutex model.

    States are plain tuples (p0, p1, p2); each process flips 0->1 or 1->0.
    Returns the shortest depth at which sum(p) > 1, exploring layer by layer.
    """
    start = (0, 0, 0)
    seen = {start}
    queue = deque([(start, 0)])
    while queue:
        state, depth = queue.popleft()
        if sum(state) > 1:
            return depth
        for i in range(3):
            nxt = list(state)
            nxt[i] = 1 - nxt[i]
            nxt = tuple(nxt)
            if nxt not in seen:
                seen.add(nxt)
                queue.append((nxt, depth + 1))
    return None


class TestAcceptanceAMutex(unittest.TestCase):
    """A: 3-process mutual exclusion must be violated at the BFS-shortest depth."""

    def test_violation_depth_matches_independent_bfs(self):
        model_path = ROOT / "examples" / "mutex3.json"
        expected_depth = reference_bfs_min_violation_depth()
        self.assertIsNotNone(expected_depth)

        # Library level.
        result = check(load_model(model_path.read_text(encoding="utf-8")), bound=12)
        self.assertEqual(result["status"], VIOLATION)
        self.assertEqual(result["depth"], expected_depth)
        self.assertEqual(len(result["trace"]), expected_depth + 1)
        self.assertEqual(len(result["counterexample"]["transitions"]), expected_depth)
        final = result["trace"][-1]
        self.assertGreater(final["p0"] + final["p1"] + final["p2"], 1)

        # CLI level.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "trace.json"
            proc = run_cli("check", str(model_path), "--bound", "12", "--out", str(out))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            cli_result = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(cli_result["status"], VIOLATION)
            self.assertEqual(cli_result["depth"], expected_depth)
            self.assertEqual(json.loads(proc.stdout)["depth"], expected_depth)


class TestAcceptanceBOutOfDomain(unittest.TestCase):
    """B: out-of-domain transitions are disabled, never an error."""

    def test_overflow_transition_disabled(self):
        model_path = ROOT / "examples" / "range.json"
        result = check(load_model(model_path.read_text(encoding="utf-8")), bound=20)
        self.assertEqual(result["status"], SAFE_BOUNDED)
        self.assertIsNone(result["error"])
        # Only the decrement transition can fire: x = 9, 8, ..., 0.
        self.assertEqual(result["visited"], 10)
        self.assertEqual(result["depth"], 9)

    def test_out_of_domain_via_cli(self):
        proc = run_cli("check", str(ROOT / "examples" / "range.json"), "--bound", "20")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], SAFE_BOUNDED)


class TestAcceptanceCCycle(unittest.TestCase):
    """C: cycle model is SAFE_BOUNDED within the bound; visited matches
    manual enumeration of the reachable state space."""

    def test_cycle_safe_bounded(self):
        model_path = ROOT / "examples" / "cycle.json"
        result = check(load_model(model_path.read_text(encoding="utf-8")), bound=12)
        self.assertEqual(result["status"], SAFE_BOUNDED)
        # Manual enumeration: x cycles 0 -> 1 -> 2 -> 0, so exactly 3 states.
        self.assertEqual(result["visited"], 3)
        self.assertEqual(result["depth"], 2)
        self.assertEqual(result["counterexample"], None)

    def test_cycle_via_cli(self):
        proc = run_cli("check", str(ROOT / "examples" / "cycle.json"), "--bound", "12")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], SAFE_BOUNDED)
        self.assertEqual(result["visited"], 3)


class TestAcceptanceDInvalidInput(unittest.TestCase):
    """D: invalid JSON / invalid model exits 2 with one-line JSON on stderr."""

    def test_invalid_json_exit2(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_model(tmp, "{not valid json")
            proc = run_cli("check", str(path))
            self.assertEqual(proc.returncode, 2)
            stderr_lines = proc.stderr.strip().splitlines()
            self.assertEqual(len(stderr_lines), 1)
            payload = json.loads(stderr_lines[0])
            self.assertIn("error", payload)

    def test_invalid_model_exit2(self):
        bad_models = [
            {"init": {"x": 0}, "transitions": [], "invariant": 5},
            {"variables": ["a", "b", "c", "d", "e", "f", "g"],
             "init": {"a": 0}, "transitions": []},
            {"init": {"x": 99}, "transitions": []},
            {"variables": ["x"], "init": {"x": 0},
             "transitions": [{"guard": "x == 0", "assign": {"y": "1"}}]},
            {"init": {"x": 0},
             "transitions": [{"guard": "x === 0", "assign": {"x": "1"}}]},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for i, model in enumerate(bad_models):
                path = write_model(tmp, model)
                proc = run_cli("check", str(path))
                self.assertEqual(proc.returncode, 2, f"model {i}: {proc.stderr}")
                self.assertEqual(len(proc.stderr.strip().splitlines()), 1)
                json.loads(proc.stderr.strip())

    def test_missing_file_exit2(self):
        proc = run_cli("check", "/nonexistent/model.json")
        self.assertEqual(proc.returncode, 2)
        json.loads(proc.stderr.strip())


class TestSemantics(unittest.TestCase):
    """Unit tests for the core semantics."""

    def check_model(self, model, bound=10):
        return check(load_model(json.dumps(model)), bound)

    def test_undefined_variable_read_is_e_read(self):
        result = self.check_model({
            "variables": ["x", "y"],
            "init": {"x": 0},
            "transitions": [{"guard": "y == 0", "assign": {"x": "1"}}],
            "invariant": "x >= 0",
        })
        self.assertEqual(result["status"], ERROR)
        self.assertEqual(result["error"]["code"], "E_READ")

    def test_undefined_variable_in_invariant_is_e_read(self):
        result = self.check_model({
            "variables": ["x", "y"],
            "init": {"x": 0},
            "transitions": [],
            "invariant": "y >= 0",
        })
        self.assertEqual(result["status"], ERROR)
        self.assertEqual(result["error"]["code"], "E_READ")

    def test_e_read_exit_code_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_model(tmp, {
                "variables": ["x", "y"],
                "init": {"x": 0},
                "transitions": [{"guard": "y == 0", "assign": {"x": "1"}}],
            })
            proc = run_cli("check", str(path))
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(json.loads(proc.stdout)["error"]["code"], "E_READ")

    def test_init_state_violation_depth_zero(self):
        result = self.check_model({
            "init": {"x": 0},
            "transitions": [],
            "invariant": "x > 5",
        })
        self.assertEqual(result["status"], VIOLATION)
        self.assertEqual(result["depth"], 0)
        self.assertEqual(result["trace"], [{"x": 0}])

    def test_duplicate_states_not_enqueued_twice(self):
        # Two transitions lead to the very same successor state.
        result = self.check_model({
            "init": {"x": 0},
            "transitions": [
                {"guard": "x == 0", "assign": {"x": "1"}},
                {"guard": "x == 0", "assign": {"x": "1"}},
                {"guard": "x == 1", "assign": {"x": "1"}},
            ],
            "invariant": "x >= 0",
        })
        self.assertEqual(result["status"], SAFE_BOUNDED)
        self.assertEqual(result["visited"], 2)

    def test_state_canonicalisation_sorted_by_name(self):
        result = self.check_model({
            "init": {"b": 1, "a": 2},
            "transitions": [],
            "invariant": "a + b > 10",
        })
        self.assertEqual(result["status"], VIOLATION)
        self.assertEqual(list(result["trace"][0].keys()), ["a", "b"])

    def test_simultaneous_assignment(self):
        result = self.check_model({
            "init": {"x": 1, "y": 2},
            "transitions": [
                {"guard": "x == 1", "assign": {"x": "y", "y": "x"}},
            ],
            "invariant": "x + y < 10",
        })
        self.assertEqual(result["status"], SAFE_BOUNDED)
        self.assertEqual(result["visited"], 2)

    def test_division_by_zero_disables_transition(self):
        result = self.check_model({
            "init": {"x": 0},
            "transitions": [
                {"guard": "x == 0 and x // x == 1", "assign": {"x": "1"}},
                {"guard": "x == 0", "assign": {"x": "2"}},
            ],
            "invariant": "x < 5",
        })
        self.assertEqual(result["status"], SAFE_BOUNDED)
        self.assertEqual(result["visited"], 2)

    def test_bound_zero_only_checks_init(self):
        result = self.check_model({
            "init": {"x": 0},
            "transitions": [{"guard": "x == 0", "assign": {"x": "1"}}],
            "invariant": "x < 5",
        }, bound=0)
        self.assertEqual(result["status"], SAFE_BOUNDED)
        self.assertEqual(result["visited"], 1)
        self.assertEqual(result["depth"], 0)

    def test_shortest_counterexample_is_first_found(self):
        # Direct violation at depth 1 and a longer path to a different
        # violating state; BFS must report depth 1.
        result = self.check_model({
            "init": {"x": 0},
            "transitions": [
                {"guard": "x == 0", "assign": {"x": "9"}},
                {"guard": "x == 0", "assign": {"x": "1"}},
                {"guard": "x == 1", "assign": {"x": "8"}},
            ],
            "invariant": "x < 5",
        })
        self.assertEqual(result["status"], VIOLATION)
        self.assertEqual(result["depth"], 1)
        self.assertEqual(result["trace"], [{"x": 0}, {"x": 9}])


if __name__ == "__main__":
    unittest.main()
