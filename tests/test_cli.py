"""CLI end-to-end tests: JSON lines in/out, exit code 6 on errors."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(lines, home):
    env = dict(os.environ, RGROUP_HOME=home)
    proc = subprocess.run(
        [sys.executable, "-m", "rgroup"],
        input="\n".join(json.dumps(line) for line in lines) + "\n",
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
    )
    responses = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return proc.returncode, responses


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def test_happy_path_write_read(self):
        code, resp = run_cli(
            [
                {"cmd": "init", "nodes": ["a", "b", "c"]},
                {"cmd": "write", "value": "hello", "node": "a"},
                {"cmd": "ack", "id": 1, "node": "b"},
                {"cmd": "read"},
            ],
            self.home,
        )
        self.assertEqual(code, 0)
        self.assertEqual(resp[0], {"ok": True, "epoch": 1})
        self.assertEqual(resp[1]["id"], 1)
        self.assertFalse(resp[1]["committed"])
        self.assertTrue(resp[2]["committed"])
        self.assertEqual(resp[3]["value"], "hello")

    def test_stale_config_error_exit_6(self):
        code, resp = run_cli(
            [
                {"cmd": "init", "nodes": ["a", "b", "c"]},
                {"cmd": "begin", "old": ["x", "y", "z"], "new": ["a", "d", "e"]},
            ],
            self.home,
        )
        self.assertEqual(code, 6)
        self.assertEqual(resp[-1]["ok"], False)
        self.assertEqual(resp[-1]["error"], "STALE_CONFIG")

    def test_commit_without_joint_exit_6(self):
        code, resp = run_cli([{"cmd": "init", "nodes": ["a"]}, {"cmd": "commit"}], self.home)
        self.assertEqual(code, 6)
        self.assertEqual(resp[-1]["error"], "NOT_IN_JOINT")

    def test_joint_write_needs_both_majorities_via_cli(self):
        code, resp = run_cli(
            [
                {"cmd": "init", "nodes": ["a", "b", "c"]},
                {"cmd": "begin", "old": ["a", "b", "c"], "new": ["c", "d", "e"]},
                {"cmd": "propose", "value": "v"},
                {"cmd": "ack", "id": 1, "node": "d"},
                {"cmd": "ack", "id": 1, "node": "e"},  # new majority only
                {"cmd": "ack", "id": 1, "node": "a"},
                {"cmd": "ack", "id": 1, "node": "c"},  # now both majorities
            ],
            self.home,
        )
        self.assertEqual(code, 0)
        committed = [r["committed"] for r in resp[3:]]
        self.assertEqual(committed, [False, False, False, True])

    def test_crash_before_fsync_recovery_via_cli(self):
        # Session 1: init, commit a write, begin change, crash during commit.
        code, resp = run_cli(
            [
                {"cmd": "init", "nodes": ["a", "b", "c"]},
                {"cmd": "write", "value": "durable", "node": "a"},
                {"cmd": "ack", "id": 1, "node": "b"},
                {"cmd": "begin", "old": ["a", "b", "c"], "new": ["a", "d", "e"]},
                {"cmd": "commit", "failpoint": "before_config_fsync"},
            ],
            self.home,
        )
        self.assertEqual(code, 6)
        self.assertEqual(resp[-1]["error"], "CRASH")

        # Session 2 (new process): recovery sees pre-crash committed state.
        code, resp = run_cli([{"cmd": "status"}, {"cmd": "read"}], self.home)
        self.assertEqual(code, 0)
        self.assertEqual(resp[0]["config"], {"members": ["a", "b", "c"], "epoch": 1})
        self.assertIsNone(resp[0]["joint"])
        self.assertEqual(resp[1]["value"], "durable")

    def test_crash_command_recovers_from_disk(self):
        run_cli(
            [
                {"cmd": "init", "nodes": ["a", "b", "c"]},
                {"cmd": "write", "value": "x", "node": "a"},
                {"cmd": "ack", "id": 1, "node": "b"},
            ],
            self.home,
        )
        code, resp = run_cli([{"cmd": "crash"}, {"cmd": "read"}], self.home)
        self.assertEqual(code, 0)
        self.assertTrue(resp[0]["recovered"])
        self.assertEqual(resp[1]["value"], "x")

    def test_old_epoch_write_rejected_via_cli(self):
        code, resp = run_cli(
            [
                {"cmd": "init", "nodes": ["a", "b", "c"]},
                {"cmd": "begin", "old": ["a", "b", "c"], "new": ["a", "d", "e"]},
                {"cmd": "commit"},
                {"cmd": "write", "value": "stale", "node": "b"},
            ],
            self.home,
        )
        self.assertEqual(code, 6)
        self.assertEqual(resp[-1]["error"], "STALE_CONFIG")


if __name__ == "__main__":
    unittest.main()
