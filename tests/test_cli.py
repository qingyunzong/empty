import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CONFIGURE = {
    "op": "configure",
    "timezones": {"utc": "UTC"},
    "nodes": {
        "root": {"windows": [
            {"id": "roll", "kind": "rolling",
             "duration_seconds": 10, "capacity": 10},
        ]},
        "s": {"parents": ["root"]},
    },
}


def run_cli(state_file, commands):
    proc = subprocess.run(
        [sys.executable, "-m", "budgetgate.cli", state_file],
        input="\n".join(json.dumps(c) for c in commands),
        capture_output=True, text=True, cwd=REPO_ROOT,
        env={**os.environ, "PYTHONPATH": REPO_ROOT},
    )
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return proc.returncode, lines


class CliTest(unittest.TestCase):
    def test_full_flow_and_durable_replay_across_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "state.json")
            code, out = run_cli(state, [
                CONFIGURE,
                {"op": "reserve", "request_id": "r1", "subject": "s",
                 "amount": 6, "execute_at": "2026-01-01T00:00:05+00:00",
                 "confirm_deadline": "2026-01-01T00:00:08+00:00",
                 "now": "2026-01-01T00:00:00+00:00"},
                {"op": "reserve", "request_id": "r2", "subject": "s",
                 "amount": 6, "execute_at": "2026-01-01T00:00:06+00:00",
                 "confirm_deadline": "2026-01-01T00:00:09+00:00",
                 "now": "2026-01-01T00:00:01+00:00"},
                {"op": "confirm", "request_id": "r1",
                 "now": "2026-01-01T00:00:02+00:00"},
            ])
            self.assertEqual(code, 0, out)
            self.assertEqual(out[0]["status"], "ok")
            self.assertEqual(out[1]["status"], "held")
            self.assertEqual(out[2]["status"], "rejected")
            self.assertEqual(out[2]["violations"][0]["window"], "roll")
            self.assertEqual(out[3]["status"], "confirmed")

            # New process, same state file: replaying the confirm is
            # idempotent, and the expired-deadline machinery still works.
            code, out = run_cli(state, [
                {"op": "confirm", "request_id": "r1",
                 "now": "2026-01-01T00:00:03+00:00"},
                {"op": "expire", "now": "2026-01-01T00:10:00+00:00"},
                {"op": "status"},
            ])
            self.assertEqual(code, 0, out)
            self.assertEqual(out[0]["status"], "confirmed")
            self.assertTrue(out[0]["replayed"])
            self.assertEqual(out[1]["expired"], [])  # r1 confirmed, not held
            holds = out[2]["state"]["holds"]
            self.assertEqual(holds["r1"]["state"], "confirmed")
            self.assertNotIn("r2", holds)  # rejected reserves leave no hold

    def test_error_lines_are_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "state.json")
            code, out = run_cli(state, [
                {"op": "reserve", "request_id": "r1", "subject": "s",
                 "amount": 1, "execute_at": "2026-01-01T00:00:00+00:00",
                 "confirm_deadline": "2026-01-01T00:00:01+00:00"},
            ])
            self.assertEqual(code, 1)
            self.assertEqual(out[0]["status"], "error")
            self.assertIn("not configured", out[0]["error"])


if __name__ == "__main__":
    unittest.main()
