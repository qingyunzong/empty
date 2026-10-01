import contextlib
import io
import json
import os
import tempfile
import unittest

from crdtsim import cli


SCENARIO = [
    {"op": "add_node", "node": "A"},
    {"op": "add_node", "node": "B"},
    {"op": "run"},
    {"op": "write", "node": "A", "key": "k", "value": "v1"},
    {"op": "partition", "a": "A", "b": "B"},
    {"op": "write", "node": "B", "key": "k", "value": "v2"},
    {"op": "run"},
    {"op": "heal", "a": "A", "b": "B"},
    {"op": "run"},
    {"op": "read", "node": "A", "key": "k"},
    {"op": "read", "node": "B", "key": "k"},
    {"op": "snapshot", "node": "A"},
    {"op": "restore", "node": "A"},
    {"op": "broadcast_acks"},
    {"op": "run"},
    {"op": "gc", "node": "A"},
]


def run_cli(argv, payload):
    with tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False
    ) as handle:
        json.dump(payload, handle)
        path = handle.name
    try:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = cli.main(argv + [path])
        return rc, json.loads(buffer.getvalue())
    finally:
        os.unlink(path)


class TestCli(unittest.TestCase):
    def test_run_produces_log_state_and_reads(self):
        rc, out = run_cli(["run"], SCENARIO)
        self.assertEqual(rc, 0)
        self.assertEqual(out["reads"][0]["values"], ["v1", "v2"])
        self.assertEqual(out["reads"][1]["values"], ["v1", "v2"])
        self.assertIn("fingerprint", out)
        self.assertTrue(out["log"])

    def test_replay_reproduces_fingerprint(self):
        _, out = run_cli(["run"], SCENARIO)
        rc, replayed = run_cli(["replay"], out["log"])
        self.assertEqual(rc, 0)
        self.assertEqual(replayed["fingerprint"], out["fingerprint"])

    def test_enumerate_ok(self):
        spec = {
            "nodes": ["A", "B"],
            "writes": [
                {"id": "w1", "node": "A", "key": "k"},
                {"id": "w2", "node": "B", "key": "k", "deps": ["w1"]},
            ],
        }
        rc, out = run_cli(["enumerate"], spec)
        self.assertEqual(rc, 0)
        self.assertTrue(out["ok"])
        self.assertGreater(out["checked"], 0)
        self.assertIsNone(out["counterexample"])


if __name__ == "__main__":
    unittest.main()
