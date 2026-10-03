"""End-to-end tests for `python -m bandjoin`."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            if isinstance(row, str):
                handle.write(row + "\n")
            else:
                handle.write(json.dumps(row) + "\n")


class CliTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.left = os.path.join(self.tmp.name, "L.jsonl")
        self.right = os.path.join(self.tmp.name, "R.jsonl")
        self.out = os.path.join(self.tmp.name, "pairs.jsonl")

    def run_cli(self, *extra_args):
        cmd = [
            sys.executable,
            "-m",
            "bandjoin",
            "--left",
            self.left,
            "--right",
            self.right,
            "--out",
            self.out,
            *extra_args,
        ]
        return subprocess.run(
            cmd, cwd=REPO_ROOT, capture_output=True, text=True
        )

    def read_out(self):
        with open(self.out, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]


class HappyPathTest(CliTestBase):
    def test_basic_join_sorted_output_and_stats(self):
        write_jsonl(self.left, [
            {"id": "l1", "key": "a", "ts": 100},
            {"id": "l2", "key": "b", "ts": 5000},
            {"id": "l3", "key": "c", "ts": 7},
        ])
        write_jsonl(self.right, [
            {"id": "r1", "key": "b", "ts": 4900},
            {"id": "r2", "key": "a", "ts": 150},
            {"id": "r3", "key": "c", "ts": 8},
        ])
        proc = self.run_cli("--bound", "5000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            self.read_out(),
            [
                {"l_id": "l1", "r_id": "r2", "key": "a",
                 "ts_l": 100, "ts_r": 150},
                {"l_id": "l2", "r_id": "r1", "key": "b",
                 "ts_l": 5000, "ts_r": 4900},
                {"l_id": "l3", "r_id": "r3", "key": "c",
                 "ts_l": 7, "ts_r": 8},
            ],
        )
        stats = json.loads(proc.stderr.strip())
        self.assertEqual(
            stats,
            {"left_total": 3, "right_total": 3, "left_dup": 0,
             "right_dup": 0, "left_late": 0, "right_late": 0, "pairs": 3},
        )

    def test_bound_zero_only_equal_ts(self):
        write_jsonl(self.left, [{"id": "l1", "key": "k", "ts": 5}])
        write_jsonl(self.right, [
            {"id": "r1", "key": "k", "ts": 5},
            {"id": "r2", "key": "k", "ts": 6},
        ])
        proc = self.run_cli("--bound", "0")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            self.read_out(),
            [{"l_id": "l1", "r_id": "r1", "key": "k", "ts_l": 5, "ts_r": 5}],
        )

    def test_empty_right_stream_finalizes(self):
        write_jsonl(self.left, [{"id": "l1", "key": "a", "ts": 1}])
        write_jsonl(self.right, [])
        proc = self.run_cli("--bound", "10")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.read_out(), [])

    def test_late_events_counted_in_stats(self):
        write_jsonl(self.left, [
            {"id": "l1", "key": "a", "ts": 100},
            {"id": "l2", "key": "a", "ts": 10},
        ])
        write_jsonl(self.right, [{"id": "r1", "key": "a", "ts": 100}])
        proc = self.run_cli("--bound", "5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        stats = json.loads(proc.stderr.strip())
        self.assertEqual(stats["left_late"], 1)
        self.assertEqual(stats["pairs"], 1)


class BadInputTest(CliTestBase):
    def test_bad_json_line_exits_2_without_output(self):
        write_jsonl(self.left, [{"id": "l1", "key": "a", "ts": 1}])
        write_jsonl(self.right, ["this is not json"])
        proc = self.run_cli("--bound", "5")
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(self.out))

    def test_missing_field_exits_2_without_output(self):
        write_jsonl(self.left, [{"id": "l1", "key": "a", "ts": 1}])
        write_jsonl(self.right, [{"id": "r1", "key": "a"}])
        proc = self.run_cli("--bound", "5")
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(self.out))

    def test_bad_type_exits_2(self):
        write_jsonl(self.left, [{"id": "l1", "key": "a", "ts": "soon"}])
        write_jsonl(self.right, [])
        proc = self.run_cli("--bound", "5")
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(self.out))

    def test_existing_output_not_clobbered_on_bad_input(self):
        write_jsonl(self.left, ["{broken"])
        write_jsonl(self.right, [])
        with open(self.out, "w", encoding="utf-8") as handle:
            handle.write("previous\n")
        proc = self.run_cli("--bound", "5")
        self.assertEqual(proc.returncode, 2)
        with open(self.out, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "previous\n")

    def test_missing_input_file_exits_2(self):
        os.unlink(self.left) if os.path.exists(self.left) else None
        write_jsonl(self.right, [])
        proc = self.run_cli("--bound", "5")
        self.assertEqual(proc.returncode, 2)

    def test_negative_bound_exits_2(self):
        write_jsonl(self.left, [])
        write_jsonl(self.right, [])
        proc = self.run_cli("--bound", "-1")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
