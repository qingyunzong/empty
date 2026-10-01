"""Input validation, INFEASIBLE handling and CLI exit codes."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

VALID = {
    "gpus": [{"id": "g0", "mem": 4, "sm": 4}],
    "requests": [
        {"id": "j", "mem": 1, "sm": 1, "shareable": True,
         "preemptible": False, "arrival": 0, "duration": 1}
    ],
}


def run_cli(args):
    return subprocess.run(
        [sys.executable, "-m", "gpupack"] + args,
        cwd=ROOT, capture_output=True, text=True,
    )


class CliCase(unittest.TestCase):
    def run_with_spec(self, spec):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        inp = Path(tmp.name) / "req.json"
        out = Path(tmp.name) / "alloc.json"
        if isinstance(spec, str):
            inp.write_text(spec)
        else:
            inp.write_text(json.dumps(spec))
        result = run_cli(["schedule", str(inp), "--out", str(out)])
        payload = out.read_text() if out.exists() else None
        return result, payload


class TestInvalidInput(CliCase):
    def expect_exit_2(self, spec):
        result, _ = self.run_with_spec(spec)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertTrue(result.stderr.startswith("error:"))

    def test_malformed_json(self):
        self.expect_exit_2("{not json")

    def test_not_an_object(self):
        self.expect_exit_2("[1, 2, 3]")

    def test_missing_requests(self):
        self.expect_exit_2({"gpus": []})

    def test_missing_gpus(self):
        self.expect_exit_2({"requests": []})

    def test_missing_field(self):
        spec = json.loads(json.dumps(VALID))
        del spec["requests"][0]["duration"]
        self.expect_exit_2(spec)

    def test_wrong_type_shareable(self):
        spec = json.loads(json.dumps(VALID))
        spec["requests"][0]["shareable"] = "yes"
        self.expect_exit_2(spec)

    def test_zero_duration(self):
        spec = json.loads(json.dumps(VALID))
        spec["requests"][0]["duration"] = 0
        self.expect_exit_2(spec)

    def test_negative_arrival(self):
        spec = json.loads(json.dumps(VALID))
        spec["requests"][0]["arrival"] = -1
        self.expect_exit_2(spec)

    def test_bool_mem(self):
        spec = json.loads(json.dumps(VALID))
        spec["requests"][0]["mem"] = True
        self.expect_exit_2(spec)

    def test_duplicate_job_id(self):
        spec = json.loads(json.dumps(VALID))
        spec["requests"].append(dict(spec["requests"][0]))
        self.expect_exit_2(spec)

    def test_duplicate_gpu_id(self):
        spec = json.loads(json.dumps(VALID))
        spec["gpus"].append(dict(spec["gpus"][0]))
        self.expect_exit_2(spec)

    def test_missing_input_file(self):
        result = run_cli(["schedule", "/nonexistent/req.json"])
        self.assertEqual(result.returncode, 2)

    def test_usage_error_is_exit_2(self):
        result = run_cli([])
        self.assertEqual(result.returncode, 2)


class TestInfeasible(CliCase):
    def test_non_shareable_exceeds_every_gpu(self):
        spec = {
            "gpus": [{"id": "g0", "mem": 4, "sm": 4}],
            "requests": [
                {"id": "huge", "mem": 8, "sm": 1, "shareable": False,
                 "preemptible": False, "arrival": 0, "duration": 1}
            ],
        }
        result, payload = self.run_with_spec(spec)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload, "INFEASIBLE\n")

    def test_shareable_exceeds_every_gpu(self):
        spec = {
            "gpus": [{"id": "g0", "mem": 4, "sm": 4}],
            "requests": [
                {"id": "huge", "mem": 1, "sm": 9, "shareable": True,
                 "preemptible": True, "arrival": 0, "duration": 1}
            ],
        }
        result, payload = self.run_with_spec(spec)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload, "INFEASIBLE\n")

    def test_no_gpus_with_requests(self):
        spec = {
            "gpus": [],
            "requests": [
                {"id": "j", "mem": 1, "sm": 1, "shareable": True,
                 "preemptible": False, "arrival": 0, "duration": 1}
            ],
        }
        result, payload = self.run_with_spec(spec)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload, "INFEASIBLE\n")


class TestEdgeCases(CliCase):
    def test_empty_requests(self):
        spec = {"gpus": [{"id": "g0", "mem": 1, "sm": 1}], "requests": []}
        result, payload = self.run_with_spec(spec)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(payload), {"jobs": []})

    def test_stdout_when_no_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            inp = Path(tmp) / "req.json"
            inp.write_text(json.dumps(VALID))
            result = run_cli(["schedule", str(inp)])
            self.assertEqual(result.returncode, 0, result.stderr)
            doc = json.loads(result.stdout)
            self.assertEqual(
                doc["jobs"],
                [{"end": 1, "gpu": "g0", "id": "j",
                  "preemptions": 0, "start": 0}],
            )


if __name__ == "__main__":
    unittest.main()
