"""CLI: JSON commands on stdin, JSON results on stdout, errors non-fatal."""

import io
import json
import unittest

from mvcc.cli import main


def run_cli(lines):
    out = io.StringIO()
    main(stream=io.StringIO("\n".join(lines) + "\n"), out=out)
    return [json.loads(line) for line in out.getvalue().splitlines()]


class TestCli(unittest.TestCase):
    def test_basic_flow(self):
        results = run_cli(
            [
                '{"op": "begin", "mode": "snapshot"}',
                '{"op": "put", "txn": 1, "key": "a", "value": 1}',
                '{"op": "get", "txn": 1, "key": "a"}',
                '{"op": "commit", "txn": 1}',
                '{"op": "begin", "mode": "read_committed"}',
                '{"op": "get", "txn": 2, "key": "a"}',
                '{"op": "get", "txn": 2, "key": "missing"}',
                '{"op": "delete", "txn": 2, "key": "a"}',
                '{"op": "get", "txn": 2, "key": "a"}',
                '{"op": "abort", "txn": 2}',
            ]
        )
        self.assertEqual(results[0], {"txn": 1})
        self.assertEqual(results[1], {"ok": True})
        self.assertEqual(results[2], {"value": 1})
        self.assertEqual(results[3], {"ok": True, "commit_ts": 1})
        self.assertEqual(results[4], {"txn": 2})
        self.assertEqual(results[5], {"value": 1})
        self.assertEqual(results[6], {"value": None})
        self.assertEqual(results[7], {"ok": True})
        self.assertEqual(results[8], {"value": None})
        self.assertEqual(results[9], {"ok": True})

    def test_errors_do_not_stop_processing(self):
        results = run_cli(
            [
                '{"op": "begin", "mode": "snapshot"}',
                '{"op": "commit", "txn": 1}',
                '{"op": "commit", "txn": 1}',
                '{"op": "get", "txn": 42, "key": "x"}',
                '{"op": "begin", "mode": "bogus"}',
                '{"op": "nope"}',
                'not json',
                '{"op": "begin", "mode": "read_committed"}',
                '{"op": "get", "txn": 2, "key": "x"}',
            ]
        )
        self.assertEqual(results[2], {"error": "TXN_STATE"})
        self.assertEqual(results[3], {"error": "UNKNOWN_TXN"})
        self.assertEqual(results[4], {"error": "INVALID_MODE"})
        self.assertEqual(results[5], {"error": "UNKNOWN_OP"})
        self.assertEqual(results[6], {"error": "BAD_JSON"})
        self.assertEqual(results[7], {"txn": 2})
        self.assertEqual(results[8], {"value": None})


if __name__ == "__main__":
    unittest.main()
