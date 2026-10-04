import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "asofjoin", *args],
        cwd=ROOT, capture_output=True, text=True,
    )


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.facts = self.dir / "facts.jsonl"
        self.dims = self.dir / "dims.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, rows):
        path.write_text("".join(
            (r if isinstance(r, str) else json.dumps(r)) + "\n" for r in rows),
            encoding="utf-8")

    def invoke(self, tol="20000"):
        return run_cli("--facts", str(self.facts), "--dim", str(self.dims), "--tol", tol)


class TestCliHappyPath(CliCase):
    def test_basic_join(self):
        self.write(self.dims, [
            {"did": "d1", "key": "k", "ts": 1000, "attr": "red"},
            {"did": "d2", "key": "k", "ts": 5000, "attr": "blue"},
            {"did": "d3", "key": "other", "ts": 40000, "attr": "pusher"},
        ])
        self.write(self.facts, [
            {"fid": "f1", "key": "k", "ts": 6000},
            {"fid": "f3", "key": "zzz", "ts": 6000},
            {"fid": "f2", "key": "k", "ts": 30000},
        ])
        proc = self.invoke()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(rows, [
            {"fid": "f1", "ts": 6000, "did": "d2", "attr": "blue", "reason": None},
            {"fid": "f3", "ts": 6000, "did": None, "attr": None, "reason": "no_dim"},
            {"fid": "f2", "ts": 30000, "did": None, "attr": None, "reason": "stale"},
        ])

    def test_late_dim_within_tol_changes_result(self):
        # d1 re-arrives later in the file with a higher ts inside tol.
        self.write(self.dims, [
            {"did": "d1", "key": "k", "ts": 1000, "attr": "v1"},
            {"did": "d1", "key": "k", "ts": 1900, "attr": "v2"},
        ])
        self.write(self.facts, [{"fid": "f1", "key": "k", "ts": 2000}])
        proc = self.invoke(tol="500")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        [row] = [json.loads(l) for l in proc.stdout.splitlines()]
        self.assertEqual(row["attr"], "v2")

    def test_blank_lines_skipped(self):
        self.write(self.dims, ["", '{"did":"d1","key":"k","ts":1,"attr":0}', "  "])
        self.write(self.facts, ['{"fid":"f1","key":"k","ts":2}', ""])
        proc = self.invoke(tol="10")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout.splitlines()), 1)


class TestCliErrors(CliCase):
    def test_bad_json_line_exits_2(self):
        self.write(self.dims, [{"did": "d1", "key": "k", "ts": 1, "attr": 0}])
        self.write(self.facts, ["not json"])
        proc = self.invoke()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr)

    def test_missing_field_exits_2(self):
        self.write(self.dims, [{"did": "d1", "key": "k", "ts": 1}])  # no attr
        self.write(self.facts, [{"fid": "f1", "key": "k", "ts": 2}])
        proc = self.invoke()
        self.assertEqual(proc.returncode, 2)

    def test_wrong_type_exits_2(self):
        self.write(self.dims, [{"did": "d1", "key": "k", "ts": "1", "attr": 0}])
        self.write(self.facts, [{"fid": "f1", "key": "k", "ts": 2}])
        proc = self.invoke()
        self.assertEqual(proc.returncode, 2)

    def test_negative_tol_exits_2(self):
        self.write(self.dims, [])
        self.write(self.facts, [])
        proc = self.invoke(tol="-1")
        self.assertEqual(proc.returncode, 2)

    def test_missing_file_exits_2(self):
        proc = run_cli("--facts", str(self.dir / "nope.jsonl"),
                       "--dim", str(self.dir / "nope2.jsonl"), "--tol", "1")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
