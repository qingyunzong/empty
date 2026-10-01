import json
import unittest
from pathlib import Path

from support import TempConfig, mesh_topo, parse_jsonl, run_cli


def simple_topo():
    topo = mesh_topo(["n1", "n2"], delay=5)
    topo["workload"] = [{"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"}]
    return topo


class TestCliValid(unittest.TestCase):
    def test_run_outputs_jsonl_and_summary(self):
        with TempConfig() as cfg:
            topo = cfg.write("topo.json", simple_topo())
            proc = run_cli("run", topo, "--steps", "1000", "--seed", "3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        records = parse_jsonl(proc.stdout)
        self.assertEqual(records[-1]["type"], "summary")
        self.assertEqual(records[-1]["delivered"], 1)
        self.assertTrue(any(r["type"] == "deliver" for r in records))

    def test_output_flag_writes_file(self):
        with TempConfig() as cfg:
            topo = cfg.write("topo.json", simple_topo())
            out = str(Path(cfg.dir) / "out.jsonl")
            proc = run_cli("run", topo, "--output", out)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout, "")
            records = parse_jsonl(Path(out).read_text())
        self.assertEqual(records[-1]["type"], "summary")

    def test_steps_limit_is_respected(self):
        with TempConfig() as cfg:
            topo = cfg.write("topo.json", simple_topo())
            proc = run_cli("run", topo, "--steps", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = parse_jsonl(proc.stdout)[-1]
        self.assertEqual(summary["steps"], 1)
        self.assertEqual(summary["delivered"], 0)


class TestCliInvalidConfig(unittest.TestCase):
    def _assert_exit2(self, topo_data=None, faults_data=None, topo_path=None):
        with TempConfig() as cfg:
            topo = topo_path or cfg.write("topo.json", topo_data)
            args = ["run", topo]
            if faults_data is not None:
                args += ["--faults", cfg.write("faults.json", faults_data)]
            proc = run_cli(*args)
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("error:", proc.stderr)

    def test_too_many_nodes(self):
        self._assert_exit2(mesh_topo([f"n{i}" for i in range(9)]))

    def test_zero_nodes(self):
        self._assert_exit2({"nodes": [], "links": [], "workload": []})

    def test_workload_unknown_node(self):
        topo = simple_topo()
        topo["workload"] = [{"time": 0, "src": "n1", "dst": "ghost"}]
        self._assert_exit2(topo)

    def test_duplicate_link(self):
        topo = simple_topo()
        topo["links"].append({"src": "n1", "dst": "n2", "delay": 1})
        self._assert_exit2(topo)

    def test_unknown_fault_type(self):
        self._assert_exit2(simple_topo(),
                           {"rules": [{"type": "explode"}]})

    def test_bad_probability(self):
        self._assert_exit2(simple_topo(),
                           {"rules": [{"type": "drop", "prob": 1.5}]})

    def test_partition_self_edge(self):
        self._assert_exit2(simple_topo(), {"rules": [
            {"type": "partition", "edges": [["n1", "n1"]],
             "start": 0, "end": 5}]})

    def test_missing_topo_file(self):
        self._assert_exit2(topo_path="/nonexistent/topo.json")

    def test_malformed_json(self):
        with TempConfig() as cfg:
            path = Path(cfg.dir) / "bad.json"
            path.write_text("{not json")
            proc = run_cli("run", str(path))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error:", proc.stderr)


class TestConsistencyAssertion(unittest.TestCase):
    def _diverging_topo(self):
        topo = mesh_topo(["n1", "n2", "n3"], delay=5)
        topo["workload"] = [
            {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
            {"time": 0, "src": "n1", "dst": "n3", "app_id": "m2"},
        ]
        return topo

    def test_divergence_reports_diverge_and_last_logs(self):
        with TempConfig() as cfg:
            topo = cfg.write("topo.json", self._diverging_topo())
            proc = run_cli("run", topo, "--assert-consistency")
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("DIVERGE n2 n3", proc.stderr)
        records = parse_jsonl(proc.stdout)
        diverge = [r for r in records if r["type"] == "diverge"]
        self.assertEqual(len(diverge), 1)
        self.assertEqual(diverge[0]["nodes"], ["n2", "n3"])
        self.assertEqual(diverge[0]["last_log"], {"n2": "m1", "n3": "m2"})
        summary = records[-1]
        self.assertTrue(summary["diverged"])
        self.assertEqual(summary["divergence"]["nodes"], ["n2", "n3"])

    def test_without_flag_divergence_is_not_checked(self):
        with TempConfig() as cfg:
            topo = cfg.write("topo.json", self._diverging_topo())
            proc = run_cli("run", topo)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = parse_jsonl(proc.stdout)[-1]
        self.assertFalse(summary["diverged"])

    def test_consistent_logs_pass(self):
        topo = mesh_topo(["n1", "n2"], delay=5)
        topo["workload"] = [
            {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
            {"time": 1, "src": "n2", "dst": "n1", "app_id": "m1"},
        ]
        with TempConfig() as cfg:
            path = cfg.write("topo.json", topo)
            proc = run_cli("run", path, "--assert-consistency")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = parse_jsonl(proc.stdout)[-1]
        self.assertFalse(summary["diverged"])
        self.assertEqual(summary["logs"], {"n1": ["m1"], "n2": ["m1"]})


if __name__ == "__main__":
    unittest.main()
