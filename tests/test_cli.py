"""CLI tests: report shape and exit codes (0 ok / 1 error diagnostics / 2 PolicyError)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CLEAN = (
    "field port: int\n"
    "action allow\n"
    "rule r1 when port in 1..100 then allow\n"
    "rule r2 when port in 101..200 then allow\n"
)
OVERLAP_ONLY = (
    "field port: int\n"
    "action allow\n"
    "rule r1 when port in 1..100 then allow\n"
    "rule r2 when port in 50..200 then allow\n"
)
SHADOWED = (
    "field port: int\n"
    "action allow\n"
    "action deny\n"
    "rule r1 when port in 1..100 then allow\n"
    "rule r2 when port in 10..50 then deny\n"
)
BROKEN = "field port: int\naction allow\nrule r1 when ports == 1 then allow\n"


def run_cli(*argv):
    return subprocess.run(
        [sys.executable, "-m", "shadowc", *argv],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.workdir = Path(self.tmp.name)

    def write_policy(self, name, content):
        path = self.workdir / name
        path.write_text(content, encoding="utf-8")
        return path

    def test_clean_policy_exit_zero_and_report_shape(self):
        policy = self.write_policy("clean.dsl", CLEAN)
        report = self.workdir / "out.json"
        proc = run_cli("compile", str(policy), "--report", str(report))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(set(data), {"table", "diagnostics"})
        self.assertEqual(len(data["table"]), 2)
        self.assertEqual(data["table"][0]["name"], "r1")
        self.assertEqual(data["table"][0]["actions"], ["allow"])
        self.assertIn("condition", data["table"][0])
        self.assertEqual(data["diagnostics"], [])

    def test_overlap_only_still_exit_zero(self):
        policy = self.write_policy("overlap.dsl", OVERLAP_ONLY)
        report = self.workdir / "out.json"
        proc = run_cli("compile", str(policy), "--report", str(report))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual([d["code"] for d in data["diagnostics"]], ["W_OVERLAP"])
        self.assertEqual(data["diagnostics"][0]["severity"], "warning")

    def test_shadow_exit_one_but_report_written(self):
        policy = self.write_policy("shadow.dsl", SHADOWED)
        report = self.workdir / "out.json"
        proc = run_cli("compile", str(policy), "--report", str(report))
        self.assertEqual(proc.returncode, 1, proc.stderr)
        data = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual([d["code"] for d in data["diagnostics"]], ["E_SHADOW"])
        self.assertEqual(data["diagnostics"][0]["rule"], "r2")
        self.assertEqual(data["diagnostics"][0]["related"], "r1")

    def test_parse_error_exit_two_and_no_report(self):
        policy = self.write_policy("broken.dsl", BROKEN)
        report = self.workdir / "out.json"
        proc = run_cli("compile", str(policy), "--report", str(report))
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("E_PARSE", proc.stderr)
        self.assertIn("3:14", proc.stderr)
        self.assertFalse(report.exists())

    def test_missing_file_exit_two(self):
        proc = run_cli("compile", str(self.workdir / "nope.dsl"))
        self.assertEqual(proc.returncode, 2)

    def test_report_defaults_to_stdout(self):
        policy = self.write_policy("clean.dsl", CLEAN)
        proc = run_cli("compile", str(policy))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(set(data), {"table", "diagnostics"})


if __name__ == "__main__":
    unittest.main()
