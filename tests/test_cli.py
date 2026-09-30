"""CLI smoke tests: python -m tenantq outputs JSON, PolicyError -> exit 2."""

import json
import os
import subprocess
import sys
import tempfile
import unittest


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "state.json")
        self.env = dict(os.environ, TENANTQ_DB=self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "tenantq", *argv],
            capture_output=True,
            text=True,
            env=self.env,
        )

    def test_full_lifecycle(self):
        self.assertEqual(self.run_cli("init").returncode, 0)
        self.assertEqual(self.run_cli("tenant", "add", "root").returncode, 0)
        self.assertEqual(
            self.run_cli("tenant", "add", "leaf", "--parent", "root").returncode, 0
        )
        self.assertEqual(self.run_cli("quota", "set", "root", "cpu", "4").returncode, 0)
        self.assertEqual(self.run_cli("quota", "set", "leaf", "cpu", "4").returncode, 0)

        proc = self.run_cli("reserve", "leaf", "cpu", "2", "--key", "k1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        reserved = json.loads(proc.stdout)
        self.assertTrue(reserved["ok"])
        self.assertEqual(reserved["state"], "pending")
        rid = reserved["reservation_id"]

        # Idempotent replay through the CLI returns the original result.
        replay = json.loads(self.run_cli("reserve", "leaf", "cpu", "2", "--key", "k1").stdout)
        self.assertEqual(replay, reserved)

        confirmed = json.loads(self.run_cli("confirm", rid).stdout)
        self.assertEqual(confirmed["state"], "confirmed")
        released = json.loads(self.run_cli("release", rid).stdout)
        self.assertEqual(released["state"], "released")

        status = json.loads(self.run_cli("status", "--tenant", "leaf").stdout)
        self.assertEqual(status["used"], {"cpu": 0})
        self.assertEqual(status["pending"], {"cpu": 0})
        self.assertEqual(status["available"]["cpu"], 4)

    def test_policy_error_exits_2_with_json_error(self):
        self.run_cli("tenant", "add", "t")
        proc = self.run_cli("reserve", "t", "cpu", "1", "--key", "k")
        self.assertEqual(proc.returncode, 2)
        error = json.loads(proc.stderr)
        self.assertFalse(error["ok"])
        self.assertEqual(error["error"]["code"], "E_CONFIG")
        # The failed reservation is persisted for audit; confirming it -> E_STATE.
        rid = error["error"]["reservation_id"]
        proc = self.run_cli("confirm", rid)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "E_STATE")

    def test_confirm_unknown_reservation_exits_2(self):
        proc = self.run_cli("confirm", "rsv-00000099")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "E_STATE")


if __name__ == "__main__":
    unittest.main()
