import json
import os
import subprocess
import sys
import tempfile
import unittest
from collections import deque

from bmc import check, load_model
from bmc.model import parse_model

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mutex_model():
    transitions = []
    for i in range(3):
        transitions.append(
            {"name": f"enter_{i}", "guard": f"p{i} == 0", "assign": {f"p{i}": "1"}}
        )
        transitions.append(
            {"name": f"exit_{i}", "guard": f"p{i} == 1", "assign": {f"p{i}": "0"}}
        )
    return {
        "variables": ["p0", "p1", "p2"],
        "init": {"p0": 0, "p1": 0, "p2": 0},
        "transitions": transitions,
        "invariant": "p0 + p1 + p2 <= 1",
    }


def independent_shortest_violation_depth():
    """Brute-force BFS over the 3-process mutex model, written
    independently of the bmc package, returning the shortest depth at
    which the invariant p0 + p1 + p2 <= 1 is violated."""
    init = (0, 0, 0)
    visited = {init}
    queue = deque([(init, 0)])
    while queue:
        (p0, p1, p2), depth = queue.popleft()
        state = (p0, p1, p2)
        for i in range(3):
            for entering in (True, False):
                if entering and state[i] == 0:
                    nxt = list(state)
                    nxt[i] = 1
                elif not entering and state[i] == 1:
                    nxt = list(state)
                    nxt[i] = 0
                else:
                    continue
                nxt = tuple(nxt)
                if nxt in visited:
                    continue
                visited.add(nxt)
                if sum(nxt) > 1:
                    return depth + 1
                queue.append((nxt, depth + 1))
    return None


class AcceptanceA(unittest.TestCase):
    """Three-process mutex: violation found at the BFS-shortest depth."""

    def test_violation_at_shortest_depth(self):
        model = parse_model(mutex_model())
        result = check(model, bound=12)
        self.assertEqual(result["status"], "VIOLATION")
        self.assertEqual(
            result["depth"], independent_shortest_violation_depth()
        )
        self.assertEqual(result["depth"], 2)
        self.assertEqual(len(result["counterexample"]), 2)
        self.assertEqual(len(result["trace"]), 3)
        final = result["trace"][-1]
        self.assertGreater(final["p0"] + final["p1"] + final["p2"], 1)


class AcceptanceB(unittest.TestCase):
    """Out-of-domain assignments disable the transition, no error."""

    def test_out_of_range_transition_disabled(self):
        model = parse_model(
            {
                "variables": ["x"],
                "init": {"x": 9},
                "transitions": [
                    {"name": "inc", "guard": "true", "assign": {"x": "x + 1"}},
                    {"name": "dec", "guard": "x > -9", "assign": {"x": "x - 1"}},
                ],
                "invariant": "x <= 9",
            }
        )
        result = check(model, bound=25)
        self.assertEqual(result["status"], "SAFE_BOUNDED")
        self.assertIsNone(result["error"])
        # Only dec is ever enabled: states 9, 8, ..., -9 = 19 states.
        self.assertEqual(result["visited"], 19)


class AcceptanceC(unittest.TestCase):
    """Ring model: SAFE_BOUNDED within bound, visited matches enumeration."""

    def test_ring_safe_bounded(self):
        model = parse_model(
            {
                "variables": ["x"],
                "init": {"x": 0},
                "transitions": [
                    {"name": "t01", "guard": "x == 0", "assign": {"x": "1"}},
                    {"name": "t12", "guard": "x == 1", "assign": {"x": "2"}},
                    {"name": "t20", "guard": "x == 2", "assign": {"x": "0"}},
                ],
                "invariant": "x >= 0",
            }
        )
        result = check(model, bound=12)
        self.assertEqual(result["status"], "SAFE_BOUNDED")
        # Hand enumeration: reachable states are x in {0, 1, 2}.
        self.assertEqual(result["visited"], 3)
        self.assertEqual(result["counterexample"], None)


class AcceptanceD(unittest.TestCase):
    """Invalid JSON model exits with code 2 and one-line JSON on stderr."""

    def run_cli(self, args):
        return subprocess.run(
            [sys.executable, "-m", "bmc"] + args,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_invalid_json_exit_2(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as handle:
            handle.write("{not valid json")
            path = handle.name
        try:
            proc = self.run_cli(["check", path, "--bound", "12"])
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 2)
        lines = [line for line in proc.stderr.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertEqual(payload["status"], "ERROR")

    def test_schema_error_exit_2(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as handle:
            json.dump({"variables": ["x"], "init": {"x": 99}}, handle)
            path = handle.name
        try:
            proc = self.run_cli(["check", path])
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 2)
        payload = json.loads(proc.stderr.strip())
        self.assertEqual(payload["error"]["code"], "E_MODEL")


class CliIntegration(unittest.TestCase):
    def test_check_writes_out_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            model_path = os.path.join(tmp, "model.json")
            out_path = os.path.join(tmp, "trace.json")
            with open(model_path, "w", encoding="utf-8") as handle:
                json.dump(mutex_model(), handle)
            proc = subprocess.run(
                [
                    sys.executable, "-m", "bmc", "check", model_path,
                    "--bound", "12", "--out", out_path,
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out_path, encoding="utf-8") as handle:
                result = json.load(handle)
            self.assertEqual(result["status"], "VIOLATION")
            self.assertEqual(result["depth"], 2)
            for key in ("status", "depth", "trace", "counterexample"):
                self.assertIn(key, result)


class Semantics(unittest.TestCase):
    def test_undefined_variable_read_is_e_read(self):
        model = parse_model(
            {
                "variables": ["x"],
                "init": {"x": 0},
                "transitions": [
                    {"name": "t", "guard": "y == 1", "assign": {"x": "1"}}
                ],
                "invariant": "x == 0",
            }
        )
        result = check(model, bound=4)
        self.assertEqual(result["status"], "ERROR")
        self.assertEqual(result["error"]["code"], "E_READ")

    def test_state_normalization_sorted_by_name(self):
        model = parse_model(
            {
                "variables": ["b", "a"],
                "init": {"b": 0, "a": 0},
                "transitions": [
                    {"name": "ta", "guard": "a == 0", "assign": {"a": "1"}},
                    {"name": "tb", "guard": "b == 0", "assign": {"b": "1"}},
                ],
                "invariant": "a + b <= 2",
            }
        )
        # Order of transitions must not duplicate states: reachable states
        # are (a,b) in {(0,0),(1,0),(0,1),(1,1)}.
        result = check(model, bound=5)
        self.assertEqual(result["status"], "SAFE_BOUNDED")
        self.assertEqual(result["visited"], 4)

    def test_no_reenqueue_of_seen_states(self):
        model = parse_model(
            {
                "variables": ["x"],
                "init": {"x": 0},
                "transitions": [
                    {"name": "up", "guard": "x == 0", "assign": {"x": "1"}},
                    {"name": "down", "guard": "x == 1", "assign": {"x": "0"}},
                ],
                "invariant": "x >= 0",
            }
        )
        result = check(model, bound=100)
        self.assertEqual(result["status"], "SAFE_BOUNDED")
        self.assertEqual(result["visited"], 2)

    def test_init_violation_depth_zero(self):
        model = parse_model(
            {
                "variables": ["x"],
                "init": {"x": 5},
                "transitions": [],
                "invariant": "x < 0",
            }
        )
        result = check(model, bound=3)
        self.assertEqual(result["status"], "VIOLATION")
        self.assertEqual(result["depth"], 0)


if __name__ == "__main__":
    unittest.main()
