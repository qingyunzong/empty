import json
import subprocess
import sys
import unittest


def run_cli(payload):
    return subprocess.run(
        [sys.executable, "-m", "slot.cli"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )


class TestCli(unittest.TestCase):
    def test_ok(self):
        proc = run_cli({"busy": [[[0, 10]]], "d": 5, "s": 0, "e": 30,
                        "prefer": [[10, 20]]})
        self.assertEqual(proc.returncode, 0)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["slots"], [[10, 30]])
        self.assertEqual(result["score"], 10)

    def test_none_status(self):
        proc = run_cli({"busy": [[[0, 100]]], "d": 5, "s": 0, "e": 100})
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout)["status"], "none")

    def test_bad_slot_exit_2(self):
        for payload in (
            {"busy": [], "d": 0, "s": 0, "e": 10},
            {"busy": [], "d": 1, "s": 10, "e": 10},
            {"busy": [[[5, 2]]], "d": 1, "s": 0, "e": 10},
            {"busy": [], "d": 1, "s": 0, "e": 10, "prefer": [[9, 4]]},
        ):
            with self.subTest(payload=payload):
                proc = run_cli(payload)
                self.assertEqual(proc.returncode, 2)
                self.assertEqual(json.loads(proc.stderr)["code"], "BAD_SLOT")

    def test_tied_slots_via_cli(self):
        proc = run_cli({"busy": [[[10, 20]]], "d": 5, "s": 0, "e": 30})
        result = json.loads(proc.stdout)
        self.assertEqual(result["slots"], [[0, 10], [20, 30]])


if __name__ == "__main__":
    unittest.main()
