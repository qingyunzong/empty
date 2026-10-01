"""CLI tests: exit codes, stdout types, JSON errors on stderr, determinism."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(src: str) -> subprocess.CompletedProcess:
    fd, path = tempfile.mkstemp(suffix=".mini")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(src)
        return subprocess.run(
            [sys.executable, "-m", "hmtype", path],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(path)


def stderr_json_lines(proc):
    lines = [l for l in proc.stderr.strip().splitlines() if l.strip()]
    return [json.loads(l) for l in lines]


class TestCli(unittest.TestCase):
    def test_well_typed_program_exit_0(self):
        proc = run_cli(
            "let id = fun x -> x\n"
            "let both = (id 1, id true)\n"
            "let fact = fix f -> fun n -> if n = 0 then 1 else n * f (n - 1)\n"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        self.assertEqual(
            proc.stdout.splitlines(),
            ["id : a -> a", "both : (int, bool)", "fact : int -> int"],
        )

    def test_type_error_exit_4_and_json(self):
        proc = run_cli("let g = (fun x -> x + 1) true\n")
        self.assertEqual(proc.returncode, 4)
        errors = stderr_json_lines(proc)
        self.assertEqual(len(errors), 1)
        err = errors[0]
        self.assertEqual(err["kind"], "TypeError")
        self.assertEqual(err["expected"], "int")
        self.assertEqual(err["actual"], "bool")
        self.assertIn("span", err)
        self.assertIn("env_snapshot", err)

    def test_occurs_error_exit_4(self):
        proc = run_cli("let f = fun x -> x x\n")
        self.assertEqual(proc.returncode, 4)
        errors = stderr_json_lines(proc)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["kind"], "OccursError")

    def test_more_than_five_errors_capped(self):
        src = "".join(
            f"let e{i} = (fun x -> x + 1) true\n" for i in range(8)
        )
        proc = run_cli(src)
        self.assertEqual(proc.returncode, 4)
        errors = stderr_json_lines(proc)
        self.assertEqual(len(errors), 5)
        self.assertTrue(all(e["kind"] == "TypeError" for e in errors))

    def test_output_is_stable_across_runs(self):
        src = (
            "let ok = fun x -> x\n"
            + "".join(
                f"let e{i} = (fun x -> x + 1) true\n" for i in range(8)
            )
        )
        first = run_cli(src)
        second = run_cli(src)
        self.assertEqual(first.returncode, second.returncode)
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(first.stderr, second.stderr)

    def test_parse_error_exit_4(self):
        proc = run_cli("let = 3\n")
        self.assertEqual(proc.returncode, 4)
        errors = stderr_json_lines(proc)
        self.assertEqual(errors[0]["kind"], "ParseError")

    def test_missing_file_exit_2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "hmtype", "/nonexistent/path.mini"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
