"""End-to-end tests for the JSON CLI (python3.11 -m bagra)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

PY = sys.executable


def run_cli(*args):
    return subprocess.run(
        [PY, "-m", "bagra", *args],
        capture_output=True, text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )


class CliTest(unittest.TestCase):
    def test_script_with_error_batch_and_recovery(self):
        script = {
            "commands": [
                {"op": "subscribe", "id": "s1", "plan": {
                    "op": "distinct",
                    "inputs": [{"op": "filter", "inputs": [
                        {"op": "scan", "table": "R"}],
                        "pred": {"kind": "cmp", "op": "not_null",
                                 "col": 0}}]}},
                {"op": "batch", "batch_id": 1, "changes": [
                    {"table": "R", "row": [1, "a"], "delta": 1},
                    {"table": "R", "row": [None, "b"], "delta": 1}]},
                {"op": "batch", "batch_id": 2, "changes": [
                    {"table": "R", "row": [1, "a"], "delta": -2}]},
                {"op": "batch", "batch_id": 3, "changes": [
                    {"table": "R", "row": [1, "a"], "delta": -1}]},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            script_path = os.path.join(tmp, "script.json")
            state_path = os.path.join(tmp, "state.json")
            with open(script_path, "w", encoding="utf-8") as fh:
                json.dump(script, fh)

            # First run: batch 2 is invalid and rolls back; exit code 1.
            proc = run_cli("--state", state_path, script_path)
            self.assertEqual(proc.returncode, 1, proc.stderr)
            out = json.loads(proc.stdout)
            self.assertFalse(out["ok"])
            self.assertEqual(out["version"], 2)  # failed batch: no bump

            results = out["results"]
            # subscribe: no initial data, no publishes.
            self.assertEqual(results[0]["published"], [])
            # batch 1: (1,'a') passes the not-null filter, distinct emits.
            self.assertEqual(results[1]["published"], [
                {"version": 1, "subscription": "s1", "seq": 0,
                 "row": [1, "a"], "delta": 1}])
            # batch 2: over-delete -> error, rolled back.
            self.assertIn("NegativeMultiplicityError", results[2]["error"])
            # batch 3: removes the last copy -> distinct deletion.
            self.assertEqual(results[3]["published"], [
                {"version": 2, "subscription": "s1", "seq": 0,
                 "row": [1, "a"], "delta": -1}])

            # Second run against the persisted state: every batch id is
            # already committed, so nothing is republished; batch 2 still
            # fails (it never committed).
            proc2 = run_cli("--state", state_path, script_path)
            out2 = json.loads(proc2.stdout)
            self.assertEqual(out2["version"], 2)
            self.assertEqual(out2["results"][1]["published"], [])
            self.assertEqual(out2["results"][3]["published"], [])

    def test_join_script(self):
        script = {
            "commands": [
                {"op": "subscribe", "id": "j", "plan": {
                    "op": "join",
                    "inputs": [{"op": "scan", "table": "R"},
                               {"op": "scan", "table": "S"}],
                    "cols": [0], "right_cols": [0]}},
                {"op": "batch", "batch_id": 1, "changes": [
                    {"table": "R", "row": [1], "delta": 1},
                    {"table": "S", "row": [1], "delta": 1},
                    {"table": "S", "row": [None], "delta": 1}]},
                {"op": "unsubscribe", "id": "j"},
                {"op": "batch", "batch_id": 2, "changes": [
                    {"table": "R", "row": [1], "delta": 1}]},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            script_path = os.path.join(tmp, "script.json")
            with open(script_path, "w", encoding="utf-8") as fh:
                json.dump(script, fh)
            proc = run_cli(script_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = json.loads(proc.stdout)
            self.assertTrue(out["ok"])
            # NULL-keyed S row does not join.
            self.assertEqual(out["results"][1]["published"], [
                {"version": 1, "subscription": "j", "seq": 0,
                 "row": [1, 1], "delta": 1}])
            # After unsubscribing, no records are published.
            self.assertEqual(out["results"][3]["published"], [])


if __name__ == "__main__":
    unittest.main()
