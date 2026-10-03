import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EVENTS = [
    {"key": "k", "ts": 0, "id": "a"},
    {"key": "k", "ts": 1000, "id": "b"},
    {"key": "k", "ts": 40000, "id": "c"},
    {"key": "k", "ts": 150000, "id": "d"},
    {"key": "k", "ts": 185000, "id": "z"},
    {"key": "k", "ts": 20000, "id": "x"},   # legal late: bridges two finals
    {"key": "k", "ts": 100000, "id": "y"},  # excessively late: dropped
    {"key": "k2", "ts": 10, "id": "q"},     # other key: unaffected
]


def run_cli(args):
    return subprocess.run([sys.executable, "-m", "sessionize", *args],
                          capture_output=True, text=True, cwd=ROOT)


def write_jsonl(lines):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line if isinstance(line, str) else json.dumps(line))
            fh.write("\n")
    return path


class TestCli(unittest.TestCase):
    def test_end_to_end(self):
        path = write_jsonl(EVENTS)
        try:
            proc = run_cli(["--in", path, "--gap", "30000", "--late", "5000"])
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        records = [json.loads(l) for l in proc.stdout.splitlines()]
        types = [r["type"] for r in records]
        self.assertEqual(types, ["FINAL", "FINAL", "FINAL",
                                 "RETRACT", "ADD", "DROP"])
        self.assertEqual([r["start"] for r in records[:3]],
                         [0, 40000, 150000])
        self.assertEqual(
            [(s["start"], s["end"]) for s in records[3]["sessions"]],
            [(0, 1000), (40000, 40000)])
        added = records[4]
        self.assertEqual((added["start"], added["end"], added["count"]),
                         (0, 40000, 4))
        self.assertEqual(set(added), {"type", "key", "start", "end",
                                      "count", "ids"})
        self.assertEqual(records[5]["id"], "y")

    def test_missing_id_exits_2(self):
        path = write_jsonl([json.dumps({"key": "k", "ts": 1})])
        try:
            proc = run_cli(["--in", path, "--gap", "30000", "--late", "5000"])
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("id", proc.stderr)

    def test_invalid_json_exits_2(self):
        path = write_jsonl(["not json"])
        try:
            proc = run_cli(["--in", path, "--gap", "30000", "--late", "5000"])
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 2)

    def test_out_option(self):
        in_path = write_jsonl(EVENTS[:5])
        fd, out_path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        try:
            proc = run_cli(["--in", in_path, "--out", out_path,
                            "--gap", "30000", "--late", "5000"])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout, "")
            with open(out_path, encoding="utf-8") as fh:
                records = [json.loads(l) for l in fh]
            self.assertEqual([r["type"] for r in records],
                             ["FINAL", "FINAL", "FINAL"])
        finally:
            os.unlink(in_path)
            os.unlink(out_path)


if __name__ == "__main__":
    unittest.main()
