import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "cli.py")


def run_cli(lines):
    payload = "\n".join(json.dumps(l) if not isinstance(l, str) else l for l in lines)
    proc = subprocess.run(
        [sys.executable, CLI],
        input=payload + "\n",
        capture_output=True,
        text=True,
    )
    out = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    return proc.returncode, out


class TestCli(unittest.TestCase):
    def test_happy_path_exit_0(self):
        code, out = run_cli([
            {"cmd": "add", "replica": "r1", "node": "a"},
            {"cmd": "inc", "replica": "r1", "node": "a", "k": 5},
            {"cmd": "dec", "replica": "r1", "node": "a", "k": 2},
            {"cmd": "value", "replica": "r1"},
        ])
        self.assertEqual(code, 0)
        self.assertEqual(out[-1], {"ok": True, "value": 3})

    def test_bad_delta_exit_8(self):
        code, out = run_cli([
            {"cmd": "add", "replica": "r1", "node": "a"},
            {"cmd": "inc", "replica": "r1", "node": "a", "k": 0},
            {"cmd": "value", "replica": "r1"},
        ])
        self.assertEqual(code, 8)
        self.assertEqual(out[1], {"ok": False, "error": "BAD_DELTA"})
        self.assertEqual(out[2], {"ok": True, "value": 0})

    def test_remove_merge_value_flow(self):
        code, out = run_cli([
            {"cmd": "add", "replica": "r1", "node": "a"},
            {"cmd": "add", "replica": "r1", "node": "b"},
            {"cmd": "add", "replica": "r1", "node": "c"},
            {"cmd": "inc", "replica": "r1", "node": "b", "k": 4},
            {"cmd": "merge", "replica": "r2", "from": "r1"},
            {"cmd": "remove", "replica": "r1", "node": "b", "voters": ["a", "c"]},
            {"cmd": "inc", "replica": "r1", "node": "b", "k": 1},      # REMOVED
            {"cmd": "inc", "replica": "r2", "node": "b", "k": 3},      # late old increment
            {"cmd": "merge", "replica": "r1", "from": "r2"},
            {"cmd": "value", "replica": "r1"},
            {"cmd": "add", "replica": "r1", "node": "b"},              # ID_RETIRED
            {"cmd": "add", "replica": "r1", "node": "d"},
            {"cmd": "value", "replica": "r1"},
        ])
        self.assertEqual(code, 8)
        self.assertEqual(out[6], {"ok": False, "error": "REMOVED"})
        self.assertEqual(out[9], {"ok": True, "value": 7})
        self.assertEqual(out[10], {"ok": False, "error": "ID_RETIRED"})
        self.assertEqual(out[12], {"ok": True, "value": 7})

    def test_no_majority_exit_8(self):
        code, out = run_cli([
            {"cmd": "add", "replica": "r1", "node": "a"},
            {"cmd": "add", "replica": "r1", "node": "b"},
            {"cmd": "add", "replica": "r1", "node": "c"},
            {"cmd": "add", "replica": "r1", "node": "d"},
            {"cmd": "remove", "replica": "r1", "node": "d", "voters": ["a", "b"]},
        ])
        # voters must be a strict majority of live members: 2 of 4 is not
        self.assertEqual(code, 8)
        self.assertEqual(out[4], {"ok": False, "error": "NO_MAJORITY"})

    def test_bad_json_exit_8(self):
        code, out = run_cli(["not json"])
        self.assertEqual(code, 8)
        self.assertEqual(out[0], {"ok": False, "error": "BAD_JSON"})


if __name__ == "__main__":
    unittest.main()
