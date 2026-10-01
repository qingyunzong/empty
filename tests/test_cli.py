"""Acceptance test E (byte-identical logs over 5 runs) plus CLI error tests."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_cli(args):
    return subprocess.run(
        [sys.executable, "-m", "fairq"] + args,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class TestEDeterministicLogs(unittest.TestCase):
    EVENTS = (
        [
            {"type": "capacity", "t": 0, "c": 2},
            {"type": "submit", "t": 0, "flow": 1, "size": 6, "prio": 3},
            {"type": "submit", "t": 0, "flow": 2, "size": 6, "prio": 1},
        ]
        + [{"type": "tick", "t": t} for t in range(1, 3)]
        + [{"type": "submit", "t": 3, "flow": 3, "size": 4, "prio": 2}]
        + [{"type": "tick", "t": t} for t in range(3, 9)]
    )

    def test_five_runs_byte_identical(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            events_path = os.path.join(td, "events.json")
            with open(events_path, "w", encoding="utf-8") as fh:
                json.dump(self.EVENTS, fh)
            outputs = []
            for i in range(5):
                out = os.path.join(td, "result%d.json" % i)
                log = os.path.join(td, "log%d.txt" % i)
                proc = run_cli(["run", events_path, "--out", out, "--log", log])
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(proc.stderr, "")
                with open(out, "rb") as fh:
                    out_bytes = fh.read()
                with open(log, "rb") as fh:
                    log_bytes = fh.read()
                outputs.append((out_bytes, log_bytes))
            for other in outputs[1:]:
                self.assertEqual(other, outputs[0])


class TestCliSample(unittest.TestCase):
    def test_bundled_sample_runs(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "result.json")
            log = os.path.join(td, "log.txt")
            proc = run_cli(
                ["run", "events.json", "--out", out, "--log", log]
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(Path(out).read_text(encoding="utf-8"))
            self.assertEqual(result["starved"], [])
            self.assertTrue(Path(log).read_text(encoding="utf-8"))


class TestCliErrors(unittest.TestCase):
    def run_with_events(self, events):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            events_path = os.path.join(td, "events.json")
            with open(events_path, "w", encoding="utf-8") as fh:
                json.dump(events, fh)
            return run_cli(["run", events_path])

    def check_error(self, events, code):
        proc = self.run_with_events(events)
        self.assertEqual(proc.returncode, 2)
        payload = json.loads(proc.stderr)
        self.assertEqual(payload["code"], code)
        self.assertIn("error", payload)

    def test_negative_size(self):
        self.check_error(
            [{"type": "submit", "t": 0, "flow": 1, "size": -1, "prio": 1}],
            "negative_size",
        )

    def test_non_positive_capacity(self):
        self.check_error([{"type": "capacity", "t": 0, "c": 0}], "invalid_capacity")

    def test_time_regression(self):
        self.check_error(
            [{"type": "tick", "t": 5}, {"type": "tick", "t": 3}],
            "time_regression",
        )

    def test_missing_input_file(self):
        proc = run_cli(["run", "no-such-file.json"])
        self.assertEqual(proc.returncode, 2)
        payload = json.loads(proc.stderr)
        self.assertEqual(payload["code"], "input_unreadable")


if __name__ == "__main__":
    unittest.main()
