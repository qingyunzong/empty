"""CLI behaviour: exit codes, INFEASIBLE handling, field validation."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

BASE = {
    "gpus": [{"id": "g0", "mem": 4, "sm": 4}],
    "requests": [
        {"id": "a", "mem": 2, "sm": 2, "shareable": True,
         "preemptible": False, "arrival": 0, "duration": 2},
    ],
}


def run_cli(args, cwd=REPO_ROOT):
    return subprocess.run([sys.executable, "-m", "gpupack"] + args,
                          cwd=cwd, capture_output=True, text=True)


class CliCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def write_req(self, payload, name="req.json", raw=None):
        path = self.tmp / name
        path.write_text(raw if raw is not None else json.dumps(payload),
                        encoding="utf-8")
        return path

    def solve(self, payload, raw=None):
        req = self.write_req(payload, raw=raw)
        out = self.tmp / "alloc.json"
        proc = run_cli(["schedule", str(req), "--out", str(out)])
        return proc, out


class TestCliValidation(CliCase):
    def test_ok_run_writes_output(self):
        proc, out = self.solve(BASE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["status"], "OK")
        self.assertEqual(payload["objective"], 2)

    def test_invalid_json_exits_2(self):
        proc, _ = self.solve(None, raw="{not json")
        self.assertEqual(proc.returncode, 2)

    def test_missing_file_exits_2(self):
        proc = run_cli(["schedule", str(self.tmp / "nope.json")])
        self.assertEqual(proc.returncode, 2)

    def test_missing_field_exits_2(self):
        bad = json.loads(json.dumps(BASE))
        del bad["requests"][0]["duration"]
        proc, _ = self.solve(bad)
        self.assertEqual(proc.returncode, 2)

    def test_wrong_type_exits_2(self):
        bad = json.loads(json.dumps(BASE))
        bad["requests"][0]["mem"] = "2"
        proc, _ = self.solve(bad)
        self.assertEqual(proc.returncode, 2)

    def test_bool_mem_exits_2(self):
        bad = json.loads(json.dumps(BASE))
        bad["requests"][0]["mem"] = True
        proc, _ = self.solve(bad)
        self.assertEqual(proc.returncode, 2)

    def test_zero_duration_exits_2(self):
        bad = json.loads(json.dumps(BASE))
        bad["requests"][0]["duration"] = 0
        proc, _ = self.solve(bad)
        self.assertEqual(proc.returncode, 2)

    def test_negative_arrival_exits_2(self):
        bad = json.loads(json.dumps(BASE))
        bad["requests"][0]["arrival"] = -1
        proc, _ = self.solve(bad)
        self.assertEqual(proc.returncode, 2)

    def test_duplicate_ids_exit_2(self):
        bad = json.loads(json.dumps(BASE))
        bad["requests"].append(dict(bad["requests"][0]))
        proc, _ = self.solve(bad)
        self.assertEqual(proc.returncode, 2)

    def test_non_bool_flag_exits_2(self):
        bad = json.loads(json.dumps(BASE))
        bad["requests"][0]["shareable"] = 1
        proc, _ = self.solve(bad)
        self.assertEqual(proc.returncode, 2)


class TestInfeasible(CliCase):
    def test_nonshareable_exceeding_every_gpu_is_infeasible(self):
        inst = {
            "gpus": [{"id": "g0", "mem": 4, "sm": 4}],
            "requests": [
                {"id": "huge", "mem": 8, "sm": 1, "shareable": False,
                 "preemptible": False, "arrival": 0, "duration": 2},
            ],
        }
        proc, out = self.solve(inst)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("INFEASIBLE", proc.stdout)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["status"], "INFEASIBLE")

    def test_shareable_exceeding_every_gpu_is_infeasible(self):
        inst = {
            "gpus": [{"id": "g0", "mem": 4, "sm": 4}],
            "requests": [
                {"id": "huge", "mem": 9, "sm": 1, "shareable": True,
                 "preemptible": True, "arrival": 0, "duration": 2},
            ],
        }
        proc, out = self.solve(inst)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["status"], "INFEASIBLE")

    def test_empty_requests_is_ok(self):
        inst = {"gpus": [{"id": "g0", "mem": 4, "sm": 4}], "requests": []}
        proc, out = self.solve(inst)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(out.read_text())
        self.assertEqual(payload["status"], "OK")
        self.assertEqual(payload["objective"], 0)
        self.assertEqual(payload["jobs"], [])


if __name__ == "__main__":
    unittest.main()
