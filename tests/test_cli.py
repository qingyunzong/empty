import json
import os
import subprocess
import sys
import tempfile
import unittest


class TestCli(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "nakproto", *args],
            capture_output=True,
            text=True,
        )

    def write_script(self, payload):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        self.addCleanup(os.unlink, path)
        return path

    def test_run_outputs_delivery_and_nak_log(self):
        path = self.write_script({"frames": [1, 2, 3, 4, 5], "loss": [3]})
        proc = self.run_cli("run", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual(output["status"], "OK")
        self.assertEqual(output["delivered"], [1, 2, 3, 4, 5])
        self.assertEqual(
            output["nak_log"], [{"tick": 3, "seq": 3, "response": "RETRANSMIT"}]
        )

    def test_non_increasing_frames_exit_with_config_error(self):
        path = self.write_script({"frames": [1, 4, 2]})
        proc = self.run_cli("run", path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("ConfigError", proc.stderr)

    def test_missing_file_exit_with_config_error(self):
        proc = self.run_cli("run", "/nonexistent/loss_script.json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("ConfigError", proc.stderr)


if __name__ == "__main__":
    unittest.main()
