"""Acceptance E: repeated runs produce byte-identical output files."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

INSTANCE = {
    "gpus": [
        {"id": "g0", "mem": 8, "sm": 8},
        {"id": "g1", "mem": 8, "sm": 8},
    ],
    "requests": [
        {"id": "a", "mem": 3, "sm": 3, "shareable": True,
         "preemptible": True, "arrival": 0, "duration": 6},
        {"id": "b", "mem": 3, "sm": 3, "shareable": True,
         "preemptible": False, "arrival": 1, "duration": 3},
        {"id": "c", "mem": 4, "sm": 4, "shareable": False,
         "preemptible": False, "arrival": 2, "duration": 2},
        {"id": "d", "mem": 2, "sm": 2, "shareable": True,
         "preemptible": True, "arrival": 0, "duration": 4},
    ],
}


def run_cli(req_path, out_path, hash_seed):
    env = dict(os.environ, PYTHONHASHSEED=str(hash_seed))
    proc = subprocess.run(
        [sys.executable, "-m", "gpupack", "schedule", str(req_path),
         "--out", str(out_path)],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True)
    return proc


class TestDeterminism(unittest.TestCase):
    def test_byte_identical_output_across_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            req = Path(tmp) / "req.json"
            req.write_text(json.dumps(INSTANCE), encoding="utf-8")
            outputs = []
            for seed in ("0", "1", "42"):
                out = Path(tmp) / f"alloc_{seed}.json"
                proc = run_cli(req, out, seed)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                outputs.append(out.read_bytes())
            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(outputs[1], outputs[2])
            payload = json.loads(outputs[0])
            self.assertEqual(payload["status"], "OK")


if __name__ == "__main__":
    unittest.main()
