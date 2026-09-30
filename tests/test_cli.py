"""End-to-end JSON CLI tests."""
from __future__ import annotations

import base64
import json
import subprocess
import sys
import tempfile
import unittest

from ftgateway import sha256_hex

DATA = b"json cli payload!"
TH = sha256_hex(DATA)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class CliTest(unittest.TestCase):
    def run_cli(self, d: str, commands: list[dict],
                extra: list[str] | None = None) -> list[dict]:
        args = [sys.executable, "-m", "ftgateway.cli",
                "--workdir", f"{d}/w", "--publish-dir", f"{d}/p",
                "--memory-threshold", "4", "--timeout", "5"]
        args += extra or []
        proc = subprocess.run(
            args, input="\n".join(json.dumps(c) for c in commands),
            capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return [json.loads(line) for line in proc.stdout.splitlines()]

    def test_full_flow_out_of_order(self):
        with tempfile.TemporaryDirectory() as d:
            replies = self.run_cli(d, [
                {"cmd": "add", "transfer_id": "t", "epoch": 0,
                 "fragment_id": "tail", "offset": 8,
                 "data_b64": b64(DATA[8:]),
                 "total_length": len(DATA), "total_hash": TH},
                {"cmd": "gaps", "transfer_id": "t", "epoch": 0},
                {"cmd": "retransmit", "transfer_id": "t", "epoch": 0,
                 "mtu": 3},
                {"cmd": "add", "transfer_id": "t", "epoch": 0,
                 "fragment_id": "head", "offset": 0,
                 "data_b64": b64(DATA[:8]),
                 "total_length": len(DATA), "total_hash": TH},
                {"cmd": "status"},
            ])
            self.assertTrue(all(r["ok"] for r in replies))
            self.assertEqual(replies[1]["gaps"], [[0, 8]])
            self.assertEqual(replies[2]["plan"],
                             [[0, 3], [3, 3], [6, 2]])
            self.assertTrue(replies[3]["committed"])
            with open(f"{d}/p/t", "rb") as fh:
                self.assertEqual(fh.read(), DATA)

    def test_conflict_and_length_change_over_cli(self):
        with tempfile.TemporaryDirectory() as d:
            replies = self.run_cli(d, [
                {"cmd": "add", "transfer_id": "t", "epoch": 0,
                 "fragment_id": "a", "offset": 0, "data_b64": b64(b"hello"),
                 "total_length": 5, "total_hash": sha256_hex(b"hello")},
                {"cmd": "add", "transfer_id": "t", "epoch": 0,
                 "fragment_id": "b", "offset": 0, "data_b64": b64(b"jello"),
                 "total_length": 5, "total_hash": sha256_hex(b"hello")},
                {"cmd": "add", "transfer_id": "t", "epoch": 0,
                 "fragment_id": "c", "offset": 0, "data_b64": b64(b"hi"),
                 "total_length": 2},
                {"cmd": "new_epoch", "transfer_id": "t"},
            ])
            self.assertEqual(replies[1]["error"], "conflict")
            self.assertEqual(replies[1]["conflict"],
                             {"start": 0, "end": 1,
                              "existing_fragment_id": "a",
                              "new_fragment_id": "b"})
            self.assertEqual(replies[2]["error"], "length_change")
            self.assertEqual(replies[3]["epoch"], 1)

    def test_recover_flag(self):
        with tempfile.TemporaryDirectory() as d:
            self.run_cli(d, [
                {"cmd": "add", "transfer_id": "t", "epoch": 0,
                 "fragment_id": "a", "offset": 0, "data_b64": b64(DATA[:8]),
                 "total_length": len(DATA), "total_hash": TH},
            ])
            replies = self.run_cli(d, [
                {"cmd": "status"},
                {"cmd": "add", "transfer_id": "t", "epoch": 0,
                 "fragment_id": "b", "offset": 8, "data_b64": b64(DATA[8:]),
                 "total_length": len(DATA), "total_hash": TH},
            ], extra=["--recover"])
            self.assertIn("t@0", replies[0]["transfers"])
            self.assertTrue(replies[1]["committed"])
            with open(f"{d}/p/t", "rb") as fh:
                self.assertEqual(fh.read(), DATA)


if __name__ == "__main__":
    unittest.main()
