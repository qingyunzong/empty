import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

DEADLOCK_OPS = {
    "resources": {"r1": 1, "r2": 1},
    "ops": [
        {"t": 0, "client": "A", "acquire": {"r1": 1}},
        {"t": 1, "client": "B", "acquire": {"r2": 1}},
        {"t": 2, "client": "A", "acquire": {"r2": 1}},
        {"t": 3, "client": "B", "acquire": {"r1": 1}},
        {"t": 4, "client": "B", "release": ["r2"]},
    ],
}

NORMAL_OPS = {
    "resources": {"r1": 2},
    "ops": [
        {"t": 0, "client": "A", "acquire": {"r1": 1}, "ttl": 2},
        {"t": 0, "client": "B", "acquire": {"r1": 1}},
        {"t": 2, "client": "C", "acquire": {"r1": 1}},
        {"t": 3, "client": "B", "release": ["r1"]},
    ],
}

BAD_OPS = {
    "resources": {"r1": 1},
    "ops": [{"t": 0, "client": "A", "acquire": {"r1": 5}}],
}


def run_cli(*args, cwd=REPO):
    return subprocess.run(
        [sys.executable, "-m", "leasesim", *args],
        cwd=cwd, capture_output=True, text=True)


class TestCli(unittest.TestCase):
    def test_run_writes_state_and_exit_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            ops = Path(tmp, "ops.json")
            out = Path(tmp, "state.json")
            ops.write_text(json.dumps(DEADLOCK_OPS))
            proc = run_cli("run", str(ops), "--out", str(out))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            state = json.loads(out.read_text())
            kinds = [e["result"] for e in state["events"]]
            self.assertEqual(kinds, ["GRANTED", "GRANTED", "WAITING",
                                     "DEADLOCK", "RELEASED", "GRANTED"])
            self.assertEqual(state["holders"], {"A": {"r1": 1, "r2": 1}})

    def test_deterministic_byte_identical_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            ops = Path(tmp, "ops.json")
            ops.write_text(json.dumps(NORMAL_OPS))
            outs = []
            for name in ("s1.json", "s2.json"):
                out = Path(tmp, name)
                proc = run_cli("run", str(ops), "--out", str(out))
                self.assertEqual(proc.returncode, 0, proc.stderr)
                outs.append(out.read_bytes())
            self.assertEqual(outs[0], outs[1])

    def test_validation_error_exit_code_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            ops = Path(tmp, "ops.json")
            ops.write_text(json.dumps(BAD_OPS))
            proc = run_cli("run", str(ops))
            self.assertEqual(proc.returncode, 2)
            self.assertIn("exceeds capacity", proc.stderr)

    def test_missing_file_exit_code_2(self):
        proc = run_cli("run", "/nonexistent/ops.json")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
