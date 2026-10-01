"""CLI contract tests: JSON lines interface, exit code 4 on errors."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = [sys.executable, str(ROOT / "orset.py")]


def run_cli(cmd, lines=()):
    payload = "".join(json.dumps(l) + "\n" for l in lines)
    return subprocess.run(CLI + [cmd], input=payload, capture_output=True, text=True)


class TestCLI(unittest.TestCase):
    def test_add_contains_dump_roundtrip(self):
        r = run_cli("add", [{"node": "A", "element": "x"}])
        self.assertEqual(r.returncode, 0, r.stderr)
        state = json.loads(r.stdout)

        r = run_cli("contains", [{"state": state, "element": "x"}])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(json.loads(r.stdout)["contains"])

        r = run_cli("contains", [{"state": state, "element": "nope"}])
        self.assertFalse(json.loads(r.stdout)["contains"])

        r = run_cli("dump", [{"state": state}])
        self.assertEqual(json.loads(r.stdout)["elements"], ["x"])

    def test_rem_merge_compact_flow(self):
        s1 = json.loads(run_cli("add", [{"node": "A", "element": "x"}]).stdout)
        s2 = json.loads(run_cli("add", [{"node": "B", "element": "y"}]).stdout)
        merged = json.loads(run_cli("merge", [{"states": [s1, s2]}]).stdout)
        self.assertEqual(json.loads(run_cli("dump", [{"state": merged}]).stdout)["elements"], ["x", "y"])

        removed = json.loads(run_cli("rem", [{"state": merged, "element": "x"}]).stdout)
        self.assertEqual(json.loads(run_cli("dump", [{"state": removed}]).stdout)["elements"], ["y"])

        compacted = json.loads(run_cli("compact", [{"state": removed, "nodes": ["A", "B"]}]).stdout)
        self.assertEqual(json.loads(run_cli("dump", [{"state": compacted}]).stdout)["elements"], ["y"])

    def test_json_lines_multiple_requests(self):
        r = run_cli("add", [{"node": "A", "element": "x"}, {"node": "A", "element": "y"}])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(r.stdout.strip().splitlines()), 2)

    def test_errors_exit_4(self):
        cases = [
            ("bogus", ['{"state": {}}']),                 # unknown command
            ("add", ["not json"]),                        # malformed JSON
            ("add", ['{"node": "A"}']),                   # missing element
            ("add", ['{"element": "x"}']),                # missing node for fresh state
            ("rem", ['{"element": "x"}']),                # missing state
            ("merge", ['{"states": []}']),                # empty states
            ("merge", ['{"states": [{"node": 1}]}']),     # invalid state
            ("contains", ['{"state": {"node": "A"}}']),   # missing element
            ("compact", ['{"state": {"node": "A"}, "nodes": "A"}']),  # bad nodes field
            ("dump", ["[1, 2]"]),                         # request not an object
        ]
        for cmd, lines in cases:
            proc = run_cli(cmd, [json.loads(l) if l.startswith(("{", "[")) else l for l in lines])
            # feed raw text for the malformed-JSON case
            if lines == ["not json"]:
                proc = subprocess.run(CLI + [cmd], input="not json\n", capture_output=True, text=True)
            self.assertEqual(proc.returncode, 4, f"{cmd} {lines}: rc={proc.returncode}")


if __name__ == "__main__":
    unittest.main()
