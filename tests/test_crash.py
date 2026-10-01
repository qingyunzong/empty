"""Acceptance D: crash before the config-record fsync recovers to the
pre-crash committed configuration; unacknowledged writes are never
persisted. Drives the real CLI as a subprocess."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(data_dir, commands, extra_env=None):
    env = dict(os.environ)
    env["CLUSTER_DATA_DIR"] = data_dir
    env["CLUSTER_NODES"] = "a,b,c"
    env["PYTHONPATH"] = REPO_ROOT
    env.pop("SIM_CRASH_BEFORE_CONFIG_FSYNC", None)
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, "-m", "repligroup"],
        input="".join(json.dumps(c) + "\n" for c in commands),
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
    )
    lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    return proc.returncode, lines


class CliBasicsTest(unittest.TestCase):
    def test_write_read_roundtrip_exit_zero(self):
        with tempfile.TemporaryDirectory() as d:
            code, out = run_cli(d, [{"cmd": "write", "value": "x"}, {"cmd": "read"}])
            self.assertEqual(code, 0)
            self.assertTrue(out[0]["ok"] and out[0]["committed"])
            self.assertEqual(out[1]["value"], "x")
            self.assertEqual(out[1]["epoch"], 1)

    def test_errors_exit_6(self):
        with tempfile.TemporaryDirectory() as d:
            code, out = run_cli(d, [{"cmd": "begin", "old": ["x"], "new": ["y"]}])
            self.assertEqual(code, 6)
            self.assertFalse(out[0]["ok"])
            self.assertEqual(out[0]["error"], "STALE_CONFIG")

    def test_unknown_command_exit_6(self):
        with tempfile.TemporaryDirectory() as d:
            code, out = run_cli(d, [{"cmd": "bogus"}])
            self.assertEqual(code, 6)
            self.assertEqual(out[0]["error"], "UNKNOWN_CMD")


class CrashRecoveryTest(unittest.TestCase):
    def test_crash_before_config_fsync_recovers_committed_config(self):
        with tempfile.TemporaryDirectory() as d:
            # Session 1: commit a write at epoch 1.
            code, out = run_cli(d, [{"cmd": "write", "value": "v1"}])
            self.assertEqual(code, 0)
            self.assertTrue(out[0]["committed"])

            # Session 2: crash exactly before fsync of the joint config record.
            code, _ = run_cli(
                d,
                [{"cmd": "begin", "old": ["a", "b", "c"], "new": ["a", "b", "d"]}],
                extra_env={"SIM_CRASH_BEFORE_CONFIG_FSYNC": "1"},
            )
            self.assertEqual(code, 2)  # simulated crash

            # Session 3: recovery must show the pre-crash committed config.
            code, out = run_cli(d, [{"cmd": "read"}])
            self.assertEqual(code, 0)
            state = out[0]
            self.assertEqual(state["epoch"], 1)
            self.assertEqual(state["phase"], "stable")
            self.assertEqual(state["members"], ["a", "b", "c"])
            self.assertEqual(state["value"], "v1")
            self.assertEqual(state["committed"], ["v1"])

    def test_committed_config_survives_restart(self):
        with tempfile.TemporaryDirectory() as d:
            code, _ = run_cli(
                d,
                [
                    {"cmd": "write", "value": "v1"},
                    {"cmd": "begin", "old": ["a", "b", "c"], "new": ["a", "b", "d"]},
                    {"cmd": "commit"},
                ],
            )
            self.assertEqual(code, 0)
            code, out = run_cli(d, [{"cmd": "read"}])
            self.assertEqual(code, 0)
            self.assertEqual(out[0]["epoch"], 3)
            self.assertEqual(out[0]["members"], ["a", "b", "d"])
            self.assertEqual(out[0]["value"], "v1")

    def test_unacknowledged_write_not_persisted(self):
        with tempfile.TemporaryDirectory() as d:
            code, out = run_cli(
                d,
                [
                    {"cmd": "write", "value": "durable"},
                    {"cmd": "propose", "value": "volatile"},
                    {"cmd": "ack", "node": "a", "seq": 2},  # no quorum
                ],
            )
            self.assertEqual(code, 0)
            self.assertFalse(out[2]["committed"])
            # Restart: the pending write must be gone.
            code, out = run_cli(d, [{"cmd": "read"}])
            self.assertEqual(code, 0)
            self.assertEqual(out[0]["value"], "durable")
            self.assertEqual(out[0]["committed"], ["durable"])
            # And its seq is unknown to the recovered cluster.
            code, out = run_cli(d, [{"cmd": "ack", "node": "b", "seq": 2}])
            self.assertEqual(code, 6)
            self.assertEqual(out[0]["error"], "UNKNOWN_PROPOSAL")


if __name__ == "__main__":
    unittest.main()
