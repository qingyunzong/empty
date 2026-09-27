"""CLI contract: JSON-lines in/out, exit code 10 on any error."""

import json
import subprocess
import sys
import unittest


def run_cli(lines):
    proc = subprocess.run(
        [sys.executable, "-m", "mvcc"],
        input="\n".join(json.dumps(l) for l in lines) + "\n",
        capture_output=True, text=True,
    )
    responses = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    return proc.returncode, responses


class CliTest(unittest.TestCase):
    def test_happy_path_exit_zero(self):
        rc, resp = run_cli([
            {"cmd": "init", "replicas": 2},
            {"cmd": "begin", "txn": "t1", "replica": "r0"},
            {"cmd": "write", "txn": "t1", "key": "a", "value": 1},
            {"cmd": "commit", "txn": "t1"},
            {"cmd": "begin", "txn": "t2", "replica": "r1",
             "ctx": {"r0": 1, "r1": 0}},
            {"cmd": "read", "txn": "t2", "key": "a"},
            {"cmd": "abort", "txn": "t2"},
            {"cmd": "gc"},
        ])
        self.assertEqual(rc, 0)
        self.assertTrue(all(r["ok"] for r in resp))
        self.assertEqual(resp[5]["value"], 1)
        self.assertIn("watermark", resp[7])

    def test_write_skew_exit_10(self):
        rc, resp = run_cli([
            {"cmd": "begin", "txn": "t1", "replica": "r0", "ctx": {}},
            {"cmd": "begin", "txn": "t2", "replica": "r1", "ctx": {}},
            {"cmd": "write", "txn": "t1", "key": "k", "value": 1},
            {"cmd": "write", "txn": "t2", "key": "k", "value": 2},
            {"cmd": "commit", "txn": "t1"},
            {"cmd": "commit", "txn": "t2"},
        ])
        self.assertEqual(rc, 10)
        self.assertFalse(resp[-1]["ok"])
        self.assertEqual(resp[-1]["error"], "WRITE_SKEW")

    def test_unknown_txn_exit_10(self):
        rc, resp = run_cli([{"cmd": "read", "txn": "nope", "key": "k"}])
        self.assertEqual(rc, 10)
        self.assertEqual(resp[0]["error"], "TXN_NOT_FOUND")

    def test_malformed_line_exit_10(self):
        proc = subprocess.run(
            [sys.executable, "-m", "mvcc"],
            input="{not json}\n", capture_output=True, text=True)
        self.assertEqual(proc.returncode, 10)
        resp = json.loads(proc.stdout.strip())
        self.assertFalse(resp["ok"])


if __name__ == "__main__":
    unittest.main()
