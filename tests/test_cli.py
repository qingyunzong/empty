import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_cli(source):
    with tempfile.NamedTemporaryFile(
            "w", suffix=".mini", delete=False, encoding="utf-8") as f:
        f.write(source)
        path = f.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "hmtype", path],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        return proc
    finally:
        Path(path).unlink()


class TestCLI(unittest.TestCase):
    def test_success_exit_0(self):
        proc = run_cli("let id = fun x -> x\nlet one = id 1\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(lines, ["id : a -> a", "one : int"])

    def test_occurs_error_exit_4(self):
        proc = run_cli("let f = fun x -> x x\n")
        self.assertEqual(proc.returncode, 4)
        payload = json.loads(proc.stdout.strip())
        self.assertEqual(payload["let"], "f")
        self.assertEqual(payload["error"], "OccursError")
        self.assertIn("span", payload)
        self.assertIn("env_snapshot", payload)

    def test_type_error_json_fields(self):
        proc = run_cli("let g = (fun x -> x + 1) true\n")
        self.assertEqual(proc.returncode, 4)
        payload = json.loads(proc.stdout.strip())
        self.assertEqual(payload["error"], "TypeError")
        self.assertEqual(payload["expected"], "int")
        self.assertEqual(payload["actual"], "bool")
        self.assertEqual(len(payload["span"]), 4)
        self.assertIn("env_snapshot", payload)

    def test_more_than_five_errors_stops_at_five(self):
        src = "".join(f"let e{i} = {i} + true\n" for i in range(7))
        proc = run_cli(src)
        self.assertEqual(proc.returncode, 4)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(len(lines), 5)
        for line in lines:
            payload = json.loads(line)
            self.assertEqual(payload["error"], "TypeError")

    def test_mixed_success_and_error(self):
        proc = run_cli("let ok = fun x -> x\nlet bad = 1 + true\n")
        self.assertEqual(proc.returncode, 4)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(lines[0], "ok : a -> a")
        self.assertEqual(json.loads(lines[1])["let"], "bad")

    def test_parse_error_exit_4(self):
        proc = run_cli("let = 1\n")
        self.assertEqual(proc.returncode, 4)
        payload = json.loads(proc.stdout.strip())
        self.assertEqual(payload["error"], "ParseError")

    def test_missing_file_exit_2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "hmtype", "no-such-file.mini"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 2)

    def test_example_src_mini(self):
        proc = subprocess.run(
            [sys.executable, "-m", "hmtype", "src.mini"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = dict(line.split(" : ", 1)
                   for line in proc.stdout.strip().splitlines())
        self.assertEqual(out["id"], "a -> a")
        self.assertEqual(out["compose"], "(a -> b) -> (c -> a) -> c -> b")
        self.assertEqual(out["pair"], "(int * bool)")
        self.assertEqual(out["fact"], "int -> int")


if __name__ == "__main__":
    unittest.main()
