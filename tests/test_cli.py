"""End-to-end tests for the JSON-lines CLI (python -m secidx)."""

import json
import subprocess
import sys
import unittest


class CliSession:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "secidx"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)

    def cmd(self, **request):
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        self.proc.stdout.close()
        self.proc.stderr.close()


class CliTests(unittest.TestCase):
    def setUp(self):
        self.cli = CliSession()

    def tearDown(self):
        self.cli.close()

    def test_basic_flow_and_empty_find(self):
        c = self.cli.cmd
        self.assertEqual(c(cmd="create_index", field="email", unique=True),
                         {"ok": True})
        self.assertEqual(c(cmd="insert", pk=1,
                           fields={"email": "a@x", "age": 3}), {"ok": True})
        # (d) empty result -> [] not an error
        self.assertEqual(c(cmd="find", field="email", value="nobody@x"),
                         {"ok": True, "rows": []})
        resp = c(cmd="find", field="email", value="a@x")
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["rows"],
                         [{"pk": 1, "fields": {"email": "a@x", "age": 3}}])
        resp = c(cmd="scan")
        self.assertEqual(len(resp["rows"]), 1)

    def test_interleaved_unique_violation_over_cli(self):
        """(a) at the protocol level."""
        c = self.cli.cmd
        c(cmd="create_index", field="k", unique=True)
        c(cmd="begin", txn="t1")
        c(cmd="begin", txn="t2")
        self.assertEqual(c(cmd="insert", txn="t1", pk=1, fields={"k": "v"}),
                         {"ok": True})
        resp = c(cmd="insert", txn="t2", pk=2, fields={"k": "v"})
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "UNIQUE_VIOLATION")
        # t2 is gone entirely
        resp = c(cmd="commit", txn="t2")
        self.assertEqual(resp["error"]["code"], "NO_SUCH_TXN")
        self.assertEqual(c(cmd="commit", txn="t1"), {"ok": True})
        resp = c(cmd="find", field="k", value="v")
        self.assertEqual([r["pk"] for r in resp["rows"]], [1])

    def test_abort_then_update_semantics_over_cli(self):
        """(b)+(c) at the protocol level."""
        c = self.cli.cmd
        c(cmd="create_index", field="email", unique=True)
        c(cmd="begin", txn="t1")
        c(cmd="insert", txn="t1", pk=1, fields={"email": "gone@x"})
        c(cmd="abort", txn="t1")
        self.assertEqual(c(cmd="find", field="email", value="gone@x"),
                         {"ok": True, "rows": []})
        c(cmd="insert", pk=2, fields={"email": "old@x"})
        c(cmd="update", pk=2, fields={"email": "new@x"})
        self.assertEqual(c(cmd="find", field="email", value="old@x"),
                         {"ok": True, "rows": []})
        resp = c(cmd="find", field="email", value="new@x")
        self.assertEqual([r["pk"] for r in resp["rows"]], [2])
        c(cmd="delete", pk=2)
        self.assertEqual(c(cmd="scan"), {"ok": True, "rows": []})

    def test_malformed_input_and_unknown_command(self):
        self.cli.proc.stdin.write("this is not json\n")
        self.cli.proc.stdin.flush()
        resp = json.loads(self.cli.proc.stdout.readline())
        self.assertFalse(resp["ok"])
        resp = self.cli.cmd(cmd="nonsense")
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["code"], "BAD_REQUEST")
        # session still alive after errors
        self.assertEqual(self.cli.cmd(cmd="scan"), {"ok": True, "rows": []})


if __name__ == "__main__":
    unittest.main()
