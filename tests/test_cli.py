"""End-to-end tests for the JSON-lines CLI."""

import json
import subprocess
import sys
import unittest


def run_cli(lines):
    proc = subprocess.run(
        [sys.executable, "-m", "si"],
        input="\n".join(lines) + "\n",
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return [json.loads(line) for line in proc.stdout.splitlines()]


class CliTests(unittest.TestCase):
    def test_write_conflict_over_cli(self):
        responses = run_cli(
            [
                json.dumps({"cmd": "begin", "txn": "a"}),
                json.dumps({"cmd": "begin", "txn": "b"}),
                json.dumps({"cmd": "write", "txn": "a", "key": "x", "value": 1}),
                json.dumps({"cmd": "write", "txn": "b", "key": "x", "value": 2}),
                json.dumps({"cmd": "commit", "txn": "a"}),
                json.dumps({"cmd": "commit", "txn": "b"}),
                json.dumps({"cmd": "dump"}),
            ]
        )
        self.assertTrue(responses[0]["ok"])
        self.assertTrue(responses[4]["ok"])
        self.assertEqual(responses[5]["error"], "WRITE_CONFLICT")
        self.assertEqual(responses[6]["state"], {"x": 1})

    def test_read_write_roundtrip_and_snapshot(self):
        responses = run_cli(
            [
                json.dumps({"cmd": "begin", "txn": "seed"}),
                json.dumps({"cmd": "write", "txn": "seed", "key": "x", "value": 1}),
                json.dumps({"cmd": "commit", "txn": "seed"}),
                json.dumps({"cmd": "begin", "txn": "r"}),
                json.dumps({"cmd": "begin", "txn": "w"}),
                json.dumps({"cmd": "write", "txn": "w", "key": "x", "value": 2}),
                json.dumps({"cmd": "commit", "txn": "w"}),
                json.dumps({"cmd": "read", "txn": "r", "key": "x"}),
                json.dumps({"cmd": "read", "txn": "r", "key": "missing"}),
            ]
        )
        self.assertEqual(responses[7]["value"], 1)  # snapshot read
        self.assertIsNone(responses[8]["value"])

    def test_malformed_input_yields_error_objects(self):
        responses = run_cli(
            [
                "not json at all",
                json.dumps(["not", "an", "object"]),
                json.dumps({"cmd": "frobnicate"}),
                json.dumps({"cmd": "read", "txn": "ghost", "key": "x"}),
                json.dumps({"cmd": "write", "txn": "t"}),  # missing key
            ]
        )
        self.assertEqual(responses[0]["error"], "BAD_JSON")
        self.assertEqual(responses[1]["error"], "BAD_REQUEST")
        self.assertEqual(responses[2]["error"], "BAD_COMMAND")
        self.assertEqual(responses[3]["error"], "UNKNOWN_TXN")
        self.assertEqual(responses[4]["error"], "BAD_REQUEST")


if __name__ == "__main__":
    unittest.main()
