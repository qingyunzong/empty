"""Acceptance E plus CLI error handling: byte-identical repeated runs,
exit code 2 on invalid input, exit code 0 on success."""

import json
import subprocess
import sys
import tempfile
import tests._bootstrap  # noqa: F401  (sys.path setup)
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CFG = {"workers": 2, "aging_step": 2, "boost": 3,
       "base_quota": {"a": 1, "b": 2}}
STREAM = [
    {"id": 1, "arrival": 0, "cost": 3, "group": "a"},
    {"id": 2, "arrival": 0, "cost": 2, "group": "b", "priority": 5},
    {"id": 3, "arrival": 1, "cost": 1, "group": "b"},
    {"id": 4, "arrival": 2, "cost": 2, "group": "a"},
]


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "ticketpool", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class CliTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.cfg_path = self.dir / "cfg.json"
        self.stream_path = self.dir / "stream.json"
        self.out_path = self.dir / "served.json"
        self.cfg_path.write_text(json.dumps(CFG))
        self.stream_path.write_text(json.dumps(STREAM))

    def tearDown(self):
        self.tmp.cleanup()

    def serve(self):
        return run_cli("serve", str(self.cfg_path), str(self.stream_path),
                       "--out", str(self.out_path))


class TestCliSuccess(CliTestBase):
    def test_exit_zero_and_output_shape(self):
        proc = self.serve()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(self.out_path.read_text())
        self.assertEqual(payload["completed"], 4)
        self.assertEqual(len(payload["tickets"]), 4)
        for entry in payload["tickets"]:
            self.assertEqual(set(entry), {"id", "group", "start", "end", "waits"})
            self.assertIsNotNone(entry["end"])

    def test_five_runs_byte_identical(self):
        outputs = []
        for _ in range(5):
            proc = self.serve()
            self.assertEqual(proc.returncode, 0, proc.stderr)
            outputs.append(self.out_path.read_bytes())
        self.assertTrue(all(blob == outputs[0] for blob in outputs))


class TestCliErrors(CliTestBase):
    def expect_exit_2(self, stream):
        self.stream_path.write_text(json.dumps(stream))
        proc = self.serve()
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("error:", proc.stderr)
        self.assertFalse(self.out_path.exists())

    def test_unknown_group(self):
        self.expect_exit_2([{"id": 1, "arrival": 0, "cost": 1, "group": "nope"}])

    def test_nonpositive_cost(self):
        self.expect_exit_2([{"id": 1, "arrival": 0, "cost": 0, "group": "a"}])
        self.expect_exit_2([{"id": 1, "arrival": 0, "cost": -2, "group": "a"}])

    def test_decreasing_arrival(self):
        self.expect_exit_2([
            {"id": 1, "arrival": 5, "cost": 1, "group": "a"},
            {"id": 2, "arrival": 3, "cost": 1, "group": "a"},
        ])

    def test_missing_file_exit_2(self):
        proc = run_cli("serve", str(self.dir / "nope.json"),
                       str(self.stream_path), "--out", str(self.out_path))
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
