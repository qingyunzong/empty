import json
import os
import subprocess
import sys
import tempfile
import unittest

from reorder.messages import make_message_frames


class TestCli(unittest.TestCase):
    def test_script_roundtrip_with_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            wal = os.path.join(tmp, "wal.jsonl")
            frames = make_message_frames("s", 0, 0, "hello", frag_count=2)
            script = "\n".join([
                json.dumps({"cmd": "recv", "frame": frames[0].to_dict()}),
                json.dumps({"cmd": "crash"}),
                json.dumps({"cmd": "recover"}),
                json.dumps({"cmd": "recv", "frame": frames[0].to_dict()}),
                json.dumps({"cmd": "recv", "frame": frames[1].to_dict()}),
                json.dumps({"cmd": "poll"}),
                json.dumps({"cmd": "status"}),
            ])
            proc = subprocess.run(
                [sys.executable, "-m", "reorder.cli",
                 "--modulus", "8", "--window", "3", "--journal", wal],
                input=script, capture_output=True, text=True, check=True)
            responses = [json.loads(line) for line in
                         proc.stdout.strip().splitlines()]
            self.assertTrue(all(r["ok"] for r in responses))
            self.assertEqual(responses[0]["result"]["status"], "ack")
            delivered = responses[5]["delivered"]
            self.assertEqual([r["content"] for r in delivered], ["hello"])
            status = responses[6]["streams"]["s:0"]
            self.assertEqual(status["delivered"], [0])
            # Delivered seqs fall behind the window and leave the ack set.
            self.assertEqual(status["acked"], [])

    def test_unknown_command_reported(self):
        proc = subprocess.run(
            [sys.executable, "-m", "reorder.cli"],
            input='{"cmd":"bogus"}\n', capture_output=True, text=True,
            check=True)
        response = json.loads(proc.stdout.strip())
        self.assertFalse(response["ok"])
        self.assertIn("unknown cmd", response["error"])


if __name__ == "__main__":
    unittest.main()
