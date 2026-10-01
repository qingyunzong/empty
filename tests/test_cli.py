import io
import json
import unittest

from si.cli import main


def run_cli(lines):
    out = io.StringIO()
    main(stream=io.StringIO("\n".join(lines) + "\n"), out=out)
    return [json.loads(line) for line in out.getvalue().splitlines()]


class TestCli(unittest.TestCase):
    def test_happy_path(self):
        responses = run_cli([
            json.dumps({"cmd": "begin", "txn": "t1"}),
            json.dumps({"cmd": "write", "txn": "t1", "key": "x", "value": 42}),
            json.dumps({"cmd": "read", "txn": "t1", "key": "x"}),
            json.dumps({"cmd": "commit", "txn": "t1"}),
            json.dumps({"cmd": "dump"}),
        ])
        self.assertTrue(responses[0]["ok"])
        self.assertTrue(responses[1]["ok"])
        self.assertEqual(responses[2], {"ok": True, "value": 42})
        self.assertTrue(responses[3]["ok"])
        self.assertEqual(responses[4], {"ok": True, "state": {"x": 42}})

    def test_write_conflict_error(self):
        responses = run_cli([
            json.dumps({"cmd": "begin", "txn": "t1"}),
            json.dumps({"cmd": "begin", "txn": "t2"}),
            json.dumps({"cmd": "write", "txn": "t1", "key": "x", "value": 1}),
            json.dumps({"cmd": "write", "txn": "t2", "key": "x", "value": 2}),
            json.dumps({"cmd": "commit", "txn": "t1"}),
            json.dumps({"cmd": "commit", "txn": "t2"}),
        ])
        self.assertEqual(responses[4], {"ok": True})
        self.assertEqual(responses[5], {"error": "WRITE_CONFLICT"})

    def test_error_codes(self):
        responses = run_cli([
            json.dumps({"cmd": "read", "txn": "ghost", "key": "x"}),
            json.dumps({"cmd": "begin", "txn": "t1"}),
            json.dumps({"cmd": "begin", "txn": "t1"}),
            json.dumps({"cmd": "frobnicate", "txn": "t1"}),
            "not json at all",
            json.dumps({"cmd": "commit"}),
        ])
        self.assertEqual(responses[0], {"error": "UNKNOWN_TXN"})
        self.assertEqual(responses[2], {"error": "TXN_EXISTS"})
        self.assertEqual(responses[3], {"error": "UNKNOWN_COMMAND"})
        self.assertEqual(responses[4], {"error": "INVALID_JSON"})
        self.assertEqual(responses[5], {"error": "INVALID_COMMAND"})

    def test_retry_after_conflict_via_cli(self):
        responses = run_cli([
            json.dumps({"cmd": "begin", "txn": "t1"}),
            json.dumps({"cmd": "begin", "txn": "t2"}),
            json.dumps({"cmd": "write", "txn": "t1", "key": "x", "value": 1}),
            json.dumps({"cmd": "write", "txn": "t2", "key": "x", "value": 2}),
            json.dumps({"cmd": "commit", "txn": "t1"}),
            json.dumps({"cmd": "commit", "txn": "t2"}),
            json.dumps({"cmd": "begin", "txn": "t3"}),
            json.dumps({"cmd": "write", "txn": "t3", "key": "x", "value": 3}),
            json.dumps({"cmd": "commit", "txn": "t3"}),
            json.dumps({"cmd": "dump"}),
        ])
        self.assertEqual(responses[5], {"error": "WRITE_CONFLICT"})
        self.assertEqual(responses[8], {"ok": True})
        self.assertEqual(responses[9], {"ok": True, "state": {"x": 3}})


if __name__ == "__main__":
    unittest.main()
