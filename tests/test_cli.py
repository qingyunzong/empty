import base64
import io
import json
import tempfile
import unittest

from reassembler.cli import run
from reassembler.fragments import sha256_hex
from reassembler.gateway import Gateway, GatewayConfig


class TestCli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.gw = Gateway(GatewayConfig(workdir=self._tmp.name, timeout=5.0))

    def ask(self, *cmds):
        stdin = io.StringIO("".join(json.dumps(c) + "\n" for c in cmds))
        stdout = io.StringIO()
        run(self.gw, stdin, stdout)
        stdout.seek(0)
        return [json.loads(line) for line in stdout]

    def test_submit_status_finalize_roundtrip(self):
        data = b"cli works"
        thash = sha256_hex(data)
        half = len(data) // 2
        replies = self.ask(
            {
                "op": "submit",
                "transfer_id": "t",
                "frag_id": "b",
                "offset": half,
                "data_b64": base64.b64encode(data[half:]).decode(),
                "total_length": len(data),
                "total_hash": thash,
            },
            {
                "op": "submit",
                "transfer_id": "t",
                "frag_id": "a",
                "offset": 0,
                "data_b64": base64.b64encode(data[:half]).decode(),
            },
            {"op": "status", "transfer_id": "t"},
            {"op": "finalize", "transfer_id": "t"},
        )
        self.assertEqual(replies[0]["status"], "accepted")
        self.assertTrue(replies[1]["complete"])
        self.assertEqual(replies[2]["gaps"], [])
        self.assertEqual(replies[3]["status"], "published")
        with open(replies[3]["path"], "rb") as fh:
            self.assertEqual(fh.read(), data)

    def test_conflict_and_retransmit_and_tick(self):
        replies = self.ask(
            {
                "op": "submit",
                "transfer_id": "t",
                "frag_id": "a",
                "offset": 0,
                "data_b64": base64.b64encode(b"aaaa").decode(),
                "total_length": 8,
            },
            {
                "op": "submit",
                "transfer_id": "t",
                "frag_id": "bad",
                "offset": 2,
                "data_b64": base64.b64encode(b"zzzz").decode(),
            },
            {"op": "retransmit", "transfer_id": "t", "mtu": 2},
            {"op": "retract", "transfer_id": "t", "frag_id": "a"},
            {"op": "retransmit", "transfer_id": "t", "mtu": 100},
            {"op": "tick", "now": 10.0},
        )
        conflict = replies[1]
        self.assertEqual(conflict["status"], "conflict")
        self.assertEqual(conflict["conflict_start"], 2)
        self.assertEqual(conflict["conflict_end"], 4)
        self.assertEqual(conflict["conflict_frag_incoming"], "bad")
        self.assertEqual(conflict["conflict_frag_existing"], "a")
        self.assertEqual(
            replies[2]["plan"],
            [{"offset": 4, "length": 2}, {"offset": 6, "length": 2}],
        )
        self.assertEqual(replies[3]["status"], "retracted")
        self.assertEqual(replies[4]["plan"], [{"offset": 0, "length": 8}])
        self.assertEqual(
            replies[5]["reclaimed"], [{"transfer_id": "t", "epoch": 0}]
        )

    def test_unknown_op_and_bad_json(self):
        replies = self.ask({"op": "bogus"})
        self.assertEqual(replies[0]["status"], "error")
        stdin = io.StringIO("not json\n")
        stdout = io.StringIO()
        run(self.gw, stdin, stdout)
        self.assertEqual(json.loads(stdout.getvalue())["status"], "error")


if __name__ == "__main__":
    unittest.main()
