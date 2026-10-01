import unittest

from support import TempConfig, parse_jsonl, run_cli


TOPO = {
    "nodes": [{"id": "n1"}, {"id": "n2", "clock_offset": 4}, {"id": "n3"}],
    "links": [
        {"src": "n1", "dst": "n2", "delay": 5, "jitter": 4},
        {"src": "n2", "dst": "n1", "delay": 3, "jitter": 2},
        {"src": "n1", "dst": "n3", "delay": 4},
        {"src": "n3", "dst": "n1", "delay": 6, "jitter": 3},
        {"src": "n2", "dst": "n3", "delay": 2},
        {"src": "n3", "dst": "n2", "delay": 7},
    ],
    "workload": [
        {"time": t, "src": src, "dst": dst, "app_id": f"m{t}"}
        for t, (src, dst) in enumerate(
            [("n1", "n2"), ("n2", "n3"), ("n3", "n1"), ("n1", "n3"),
             ("n2", "n1"), ("n3", "n2")])
    ],
}

FAULTS = {"rules": [
    {"type": "drop", "prob": 0.3},
    {"type": "dup", "prob": 0.4},
    {"type": "delay", "dst": "n2", "extra": 2},
    {"type": "partition", "edges": [["n1", "n3"], ["n3", "n1"]],
     "start": 2, "end": 9},
    {"type": "clock", "node": "n1", "offset": -2, "start": 5},
]}


class TestDeterminism(unittest.TestCase):
    def test_fixed_seed_twice_identical_summary(self):
        with TempConfig() as cfg:
            topo = cfg.write("topo.json", TOPO)
            faults = cfg.write("faults.json", FAULTS)
            runs = [run_cli("run", topo, "--faults", faults,
                            "--steps", "1000", "--seed", "3")
                    for _ in range(2)]
        for proc in runs:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(runs[0].stdout, runs[1].stdout)
        summaries = [parse_jsonl(p.stdout)[-1] for p in runs]
        self.assertEqual(summaries[0], summaries[1])
        self.assertEqual(summaries[0]["type"], "summary")
        self.assertEqual(len(summaries[0]["digest"]), 64)

    def test_repeated_runs_stable_digest(self):
        with TempConfig() as cfg:
            topo = cfg.write("topo.json", TOPO)
            faults = cfg.write("faults.json", FAULTS)
            digests = set()
            for _ in range(3):
                proc = run_cli("run", topo, "--faults", faults,
                               "--steps", "1000", "--seed", "3")
                self.assertEqual(proc.returncode, 0, proc.stderr)
                digests.add(parse_jsonl(proc.stdout)[-1]["digest"])
        self.assertEqual(len(digests), 1)


if __name__ == "__main__":
    unittest.main()
