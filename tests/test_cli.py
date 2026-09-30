"""Acceptance tests for the CLI: python -m vclock run scenario.json."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCENARIO = {
    "until": 100,
    "events": [
        {"tick": 10, "prio": 1, "name": "evt-a"},
        {"tick": 10, "prio": 0, "name": "evt-b",
         "spawn": [{"delay": 0, "prio": 5, "name": "evt-c"}]},
        {"tick": 5, "prio": 0, "name": "evt-d"},
    ],
    "sessions": [
        {"type": "heartbeat", "id": "hb", "interval": 30, "timeout": 60,
         "pong_delay": None},
        {"type": "arq", "id": "arq", "packets": 2, "timeout": 10,
         "ack_delay": 2},
    ],
}


class TestCLI(unittest.TestCase):
    def run_cli(self, scenario):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump(scenario, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "vclock", "run", path],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        return [json.loads(line) for line in proc.stdout.splitlines()]

    def test_jsonl_trace(self):
        records = self.run_cli(SCENARIO)
        # Valid JSONL with monotonically increasing global order.
        self.assertEqual([r["order"] for r in records],
                         list(range(len(records))))

        execs = [(r["tick"], r["name"]) for r in records
                 if r["kind"] == "exec"]
        # tick 5: evt-d; tick 10: evt-b (prio 0), evt-a (prio 1),
        # then evt-c spawned same-tick by evt-b.
        self.assertEqual(execs, [(5, "evt-d"), (10, "evt-b"),
                                 (10, "evt-a"), (10, "evt-c")])

        states = {(r["session"], r["state"]): r["tick"] for r in records
                  if r["kind"] == "state"}
        self.assertEqual(states[("hb", "DEAD")], 60)
        self.assertEqual(states[("arq", "DONE")], 4)

        # Ticks in the trace never decrease.
        ticks = [r["tick"] for r in records]
        self.assertEqual(ticks, sorted(ticks))

        self.assertEqual(records[-1]["kind"], "end")
        self.assertEqual(records[-1]["tick"], 100)

    def test_missing_file_fails(self):
        proc = subprocess.run(
            [sys.executable, "-m", "vclock", "run", "/nonexistent/x.json"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
