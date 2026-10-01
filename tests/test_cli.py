import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def run_cli(request):
    with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False) as fh:
        json.dump(request, fh)
        path = fh.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "symdfa", path],
            capture_output=True, text=True, timeout=30,
            cwd=Path(__file__).resolve().parent.parent,
        )
    finally:
        Path(path).unlink(missing_ok=True)
    return proc


DFA1 = {
    "num_states": 2, "start": 0, "accepting": [1],
    "transitions": {"0": [[0, 9, 1]]},
}
DFA2 = {
    "num_states": 2, "start": 0, "accepting": [1],
    "transitions": {"0": [[0, 19, 1]]},
}


class TestCLI(unittest.TestCase):
    def test_equivalence_with_witness(self):
        proc = run_cli({"command": "equivalence", "dfa1": DFA1, "dfa2": DFA2})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "not_equivalent")
        self.assertEqual(out["witness"], [10])

    def test_inclusion_and_proof_roundtrip_through_cli(self):
        proc = run_cli({"command": "inclusion", "dfa1": DFA1, "dfa2": DFA2})
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "included")
        self.assertIn("proof", out)
        # verify the emitted proof through the CLI
        proc = run_cli({"command": "verify-proof", "dfa1": DFA1,
                        "dfa2": DFA2, "proof": out["proof"]})
        out = json.loads(proc.stdout)
        self.assertTrue(out["valid"], out)

    def test_budget_unknown_has_frontier(self):
        proc = run_cli({"command": "equivalence", "dfa1": DFA1,
                        "dfa2": DFA2, "budget": 0})
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "unknown")
        self.assertTrue(out["frontier"])

    def test_replay_witness(self):
        proc = run_cli({"command": "replay-witness", "dfa1": DFA1,
                        "dfa2": DFA2, "witness": [10]})
        out = json.loads(proc.stdout)
        self.assertTrue(out["valid"], out)
        proc = run_cli({"command": "replay-witness", "dfa1": DFA1,
                        "dfa2": DFA2, "witness": [5]})
        out = json.loads(proc.stdout)
        self.assertFalse(out["valid"])

    def test_invalid_dfa_reports_error(self):
        bad = {"num_states": 2, "transitions": {"0": [[0, 5, 1], [3, 9, 1]]}}
        proc = run_cli({"command": "equivalence", "dfa1": bad, "dfa2": DFA2})
        self.assertEqual(proc.returncode, 2)
        out = json.loads(proc.stdout)
        self.assertIn("error", out)
        self.assertIn("overlap", out["error"])

    def test_stdin_request(self):
        proc = subprocess.run(
            [sys.executable, "-m", "symdfa"],
            input=json.dumps({"command": "equivalence",
                              "dfa1": DFA1, "dfa2": DFA1}),
            capture_output=True, text=True, timeout=30,
            cwd=Path(__file__).resolve().parent.parent,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], "equivalent")


if __name__ == "__main__":
    unittest.main()
