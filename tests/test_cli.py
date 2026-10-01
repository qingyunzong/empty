"""CLI end-to-end tests: JSONL output, summary, exit codes, --check."""

import json
import unittest

from helpers import TempDirCaseMixin, run_cli, write_json

TOPO = {
    "nodes": ["n1", "n2", "n3"],
    "links": [
        {"src": "n1", "dst": "n2", "latency": 3, "jitter": 2},
        {"src": "n2", "dst": "n1", "latency": 2},
        {"src": "n1", "dst": "n3", "latency": 4},
    ],
    "clock_offsets": {"n2": 5},
    "workload": [
        {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
        {"time": 1, "src": "n2", "dst": "n1", "app_id": "m2"},
        {"time": 2, "src": "n1", "dst": "n3", "app_id": "m3"},
    ],
}

FAULTS = {
    "drop": [{"src": "n1", "dst": "n2", "rate": 0.3}],
    "dup": [{"src": "n2", "dst": "n1", "rate": 0.5, "copies": 1}],
    "delay": [{"src": "*", "dst": "n3", "extra": 2}],
}


class TestCli(TempDirCaseMixin, unittest.TestCase):
    def _write_inputs(self):
        d = self.make_tempdir()
        topo = write_json(d, "topo.json", TOPO)
        faults = write_json(d, "faults.json", FAULTS)
        return topo, faults

    def test_run_outputs_jsonl_and_summary(self):
        topo, faults = self._write_inputs()
        proc = run_cli("run", topo, "--faults", faults, "--steps", "1000", "--seed", "3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertTrue(lines)
        events = [json.loads(line) for line in lines]
        summary = events[-1]
        self.assertEqual(summary["type"], "summary")
        self.assertEqual(summary["seed"], 3)
        for key in ("sent", "delivered", "dropped", "duplicated", "dup_ignored", "log_hash"):
            self.assertIn(key, summary)
        for event in events[:-1]:
            self.assertIn(event["type"], {"send", "recv", "drop", "dup", "dup_ignored", "buffered", "timeout", "clock_apply"})

    def test_fixed_seed_identical_output(self):
        topo, faults = self._write_inputs()
        args = ("run", topo, "--faults", faults, "--steps", "1000", "--seed", "3")
        first = run_cli(*args)
        second = run_cli(*args)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, second.stdout)

    def test_check_flag_ok(self):
        topo, faults = self._write_inputs()
        proc = run_cli("run", topo, "--faults", faults, "--steps", "500", "--seed", "3", "--check")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "OK")

    def test_invalid_config_exits_2(self):
        d = self.make_tempdir()
        bad = write_json(d, "bad.json", {"nodes": [f"n{i}" for i in range(9)]})
        proc = run_cli("run", bad)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error:", proc.stderr)

    def test_unknown_node_in_workload_exits_2(self):
        d = self.make_tempdir()
        bad = write_json(
            d,
            "bad.json",
            {"nodes": ["n1"], "workload": [{"time": 0, "src": "n1", "dst": "ghost", "app_id": "m"}]},
        )
        proc = run_cli("run", bad)
        self.assertEqual(proc.returncode, 2)

    def test_missing_faults_file_exits_2(self):
        topo, _ = self._write_inputs()
        proc = run_cli("run", topo, "--faults", "/nonexistent/faults.json")
        self.assertEqual(proc.returncode, 2)

    def test_run_without_faults(self):
        topo, _ = self._write_inputs()
        proc = run_cli("run", topo, "--steps", "100", "--seed", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(summary["delivered"], 3)


if __name__ == "__main__":
    unittest.main()
