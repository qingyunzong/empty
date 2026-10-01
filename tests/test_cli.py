import json
import os
import subprocess
import sys
import unittest

import _support  # noqa: F401  (sys.path setup)

ROOT = _support.ROOT
CLI = os.path.join(ROOT, "cli.py")


def run_cli(lines):
    payload = "\n".join(lines) + "\n"
    proc = subprocess.run(
        [sys.executable, CLI],
        input=payload,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    out = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return proc.returncode, out


class TestCLI(unittest.TestCase):
    def test_happy_path_exit_zero(self):
        code, out = run_cli([
            json.dumps({"cmd": "inc", "node": "A", "k": 5}),
            json.dumps({"cmd": "dec", "node": "A", "k": 2}),
            json.dumps({"cmd": "inc", "node": "B", "k": 1}),
            json.dumps({"cmd": "inc", "node": "C", "k": 1}),
            json.dumps({"cmd": "merge", "dst": "B", "src": "A"}),
            json.dumps({"cmd": "value", "node": "B"}),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(out[0], {"ok": True, "value": 5})
        self.assertEqual(out[1], {"ok": True, "value": 3})
        self.assertEqual(out[-1], {"ok": True, "value": 4})

    def test_bad_delta_exit_8(self):
        code, out = run_cli([
            json.dumps({"cmd": "inc", "node": "A", "k": 0}),
            json.dumps({"cmd": "inc", "node": "A", "k": -2}),
        ])
        self.assertEqual(code, 8)
        self.assertEqual([r["error"] for r in out], ["BAD_DELTA", "BAD_DELTA"])

    def test_removed_write_exit_8_and_state_kept(self):
        code, out = run_cli([
            json.dumps({"cmd": "inc", "node": "A", "k": 2}),
            json.dumps({"cmd": "inc", "node": "B", "k": 2}),
            json.dumps({"cmd": "inc", "node": "C", "k": 2}),
            json.dumps({"cmd": "remove", "node": "B"}),
            json.dumps({"cmd": "inc", "node": "B", "k": 9}),
            json.dumps({"cmd": "value", "node": "B"}),
            json.dumps({"cmd": "merge", "dst": "C", "src": "B"}),
            json.dumps({"cmd": "value", "node": "C"}),
        ])
        self.assertEqual(code, 8)
        self.assertEqual(out[4], {"ok": False, "error": "REMOVED"})
        self.assertEqual(out[5], {"ok": True, "value": 2})
        self.assertEqual(out[7], {"ok": True, "value": 4})

    def test_rejoin_and_double_remove_exit_8(self):
        code, out = run_cli([
            json.dumps({"cmd": "inc", "node": "A", "k": 1}),
            json.dumps({"cmd": "inc", "node": "B", "k": 1}),
            json.dumps({"cmd": "inc", "node": "C", "k": 1}),
            json.dumps({"cmd": "remove", "node": "B"}),
            json.dumps({"cmd": "remove", "node": "B"}),
            json.dumps({"cmd": "inc", "node": "D", "k": 4}),
            json.dumps({"cmd": "value", "node": "D"}),
        ])
        self.assertEqual(code, 8)
        self.assertEqual(out[4], {"ok": False, "error": "ID_RETIRED"})
        self.assertEqual(out[6], {"ok": True, "value": 4})

    def test_no_majority_exit_8(self):
        code, out = run_cli([
            json.dumps({"cmd": "inc", "node": "A", "k": 1}),
            json.dumps({"cmd": "inc", "node": "B", "k": 1}),
            json.dumps({"cmd": "remove", "node": "A"}),
        ])
        self.assertEqual(code, 8)
        self.assertEqual(out[-1], {"ok": False, "error": "NO_MAJORITY"})

    def test_bad_command_and_bad_json_exit_8(self):
        code, out = run_cli([
            "this is not json",
            json.dumps({"cmd": "explode"}),
            json.dumps({"cmd": "value", "node": "GHOST"}),
        ])
        self.assertEqual(code, 8)
        self.assertEqual([r["error"] for r in out],
                         ["BAD_COMMAND", "BAD_COMMAND", "NOT_FOUND"])

    def test_error_does_not_abort_session(self):
        code, out = run_cli([
            json.dumps({"cmd": "inc", "node": "A", "k": 0}),
            json.dumps({"cmd": "inc", "node": "A", "k": 3}),
            json.dumps({"cmd": "value", "node": "A"}),
        ])
        self.assertEqual(code, 8)
        self.assertEqual(out[1], {"ok": True, "value": 3})
        self.assertEqual(out[2], {"ok": True, "value": 3})


if __name__ == "__main__":
    unittest.main()
