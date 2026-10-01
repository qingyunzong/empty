import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

NFA_DOC = {
    "num_states": 4,
    "start": 0,
    "finals": [3],
    "edges": [
        {"id": 0, "src": 0, "dst": 1, "lo": None, "hi": None},
        {"id": 1, "src": 1, "dst": 0, "lo": None, "hi": None},
        {"id": 2, "src": 1, "dst": 2, "lo": 97, "hi": 122},
        {"id": 3, "src": 2, "dst": 3, "lo": 48, "hi": 57},
    ],
    "next_edge_id": 4,
    "version": 4,
    "eps_version": 2,
}


def run_cli(*args, expect=0):
    proc = subprocess.run(
        [sys.executable, "-m", "lazydfa", *args],
        capture_output=True, text=True)
    if proc.returncode != expect:
        raise AssertionError(
            "cli %r exited %d: %s" % (args, proc.returncode, proc.stderr))
    return proc.stdout


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.nfa_path = self.dir / "nfa.json"
        self.nfa_path.write_text(json.dumps(NFA_DOC))

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, *extra, expect=0):
        out = run_cli("build", str(self.nfa_path), *extra, expect=expect)
        return json.loads(out)

    def query(self, machine, symbols, expect):
        path = self.dir / "machine.json"
        path.write_text(json.dumps(machine))
        out = run_cli("query", str(path), symbols, expect=expect)
        return json.loads(out)["result"]

    def test_build_and_query(self):
        machine = self.build()
        self.assertEqual(self.query(machine, "a5", 0), "accept")
        self.assertEqual(self.query(machine, "a", 1), "reject")
        self.assertEqual(self.query(machine, "A5", 1), "reject")
        self.assertEqual(self.query(machine, "[97, 56]", 0), "accept")

    def test_unknown_when_budget_blocks_expansion(self):
        machine = self.build("--state-budget", "1")
        self.assertEqual(self.query(machine, "a5", 1), "unknown")

    def test_incremental_expand_matches_full_build(self):
        full = self.build()
        step = self.build("--no-expand")
        for _ in range(8):
            path = self.dir / "step.json"
            path.write_text(json.dumps(step))
            step = json.loads(run_cli("expand", str(path), "--steps", "1"))
        path = self.dir / "step.json"
        path.write_text(json.dumps(step))
        step = json.loads(run_cli("expand", str(path)))
        self.assertEqual(step, full)

    def test_check_reports_no_mismatches(self):
        out = run_cli("check", str(self.nfa_path), "--max-len", "3")
        report = json.loads(out)
        self.assertEqual(report["mismatches"], [])
        self.assertGreater(report["checked"], 0)

    def test_witnesses_present_in_cli_output(self):
        machine = self.build()
        seen = set()
        for state in machine["states"]:
            for tr in state["transitions"]:
                self.assertTrue(tr["witnesses"])
                seen.update(tr["witnesses"])
        self.assertEqual(seen, {2, 3})


if __name__ == "__main__":
    unittest.main()
