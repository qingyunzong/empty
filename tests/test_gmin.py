import os
import subprocess
import sys
import tempfile
import unittest
from itertools import combinations
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from gmin.core import Oracle, reduce_text  # noqa: E402

ORACLE_TWO_LINES = """
import sys
lines = sys.stdin.read().split("\\n")
if "key-one" in lines and "key-two" in lines:
    sys.exit(42)
sys.exit(0)
"""

ORACLE_MULTIBYTE = """
import sys
if "\\u754c" in sys.stdin.read():
    sys.exit(42)
sys.exit(0)
"""

ORACLE_FLAKY = """
import sys
data = sys.stdin.read()
if "BUG" in data and len(data.encode("utf-8")) % 3 != 0:
    sys.exit(42)
sys.exit(1)
"""

ORACLE_SLEEPY = """
import time
time.sleep(30)
"""

NOISY_LINES = [
    "# comment noise alpha",
    "key-one",
    "# comment noise beta",
    "filler line",
    "key-two",
    "# comment noise gamma",
    "trailing filler",
    "# comment noise delta",
]


def write(tmp, name, content):
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return path


def brute_force_minimal(lines, predicate):
    for size in range(len(lines) + 1):
        for combo in combinations(range(len(lines)), size):
            candidate = [lines[i] for i in combo]
            if predicate("\n".join(candidate)):
                return candidate
    return []


class LibraryReduceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def oracle(self, source, budget):
        path = write(self.tmp.name, "oracle.py", source)
        return Oracle(path=path, budget=budget)

    def test_a_comment_noise_matches_brute_force_reference(self):
        text = "\n".join(NOISY_LINES)
        oracle = self.oracle(ORACLE_TWO_LINES, budget=500)
        result = reduce_text(text, oracle)
        reference = brute_force_minimal(
            NOISY_LINES,
            lambda t: "key-one" in t.split("\n") and "key-two" in t.split("\n"),
        )
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.text, "\n".join(reference))
        self.assertEqual(result.text, "key-one\nkey-two")

    def test_b_multibyte_characters_are_never_split(self):
        text = "# 注释噪声\n噪声行 noise\n目标界目标\n🙂🙂🙂"
        oracle = self.oracle(ORACLE_MULTIBYTE, budget=1000)
        result = reduce_text(text, oracle)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.text, "界")
        self.assertEqual(result.text.encode("utf-8").decode("utf-8"), result.text)

    def test_c_zero_budget_immediately_exceeds(self):
        oracle = self.oracle(ORACLE_TWO_LINES, budget=0)
        result = reduce_text("\n".join(NOISY_LINES), oracle)
        self.assertEqual(result.status, "BUDGET_EXCEEDED")
        self.assertEqual(result.checks, 0)
        self.assertEqual(result.text, "\n".join(NOISY_LINES))

    def test_d_flaky_non_42_is_never_accepted(self):
        text = "# noise one\nBUG\n# noise two\nfiller"
        oracle = self.oracle(ORACLE_FLAKY, budget=500)
        result = reduce_text(text, oracle)
        self.assertEqual(result.status, "OK")
        self.assertIn("BUG", result.text)
        self.assertLess(len(result.text), len(text))

    def test_timeout_counts_as_not_triggered(self):
        oracle = self.oracle(ORACLE_SLEEPY, budget=2)
        result = reduce_text("alpha\nbeta", oracle)
        self.assertEqual(result.status, "BUDGET_EXCEEDED")
        self.assertEqual(result.checks, 2)
        self.assertEqual(result.text, "alpha\nbeta")

    def test_budget_exhaustion_keeps_current_candidate(self):
        text = "\n".join(NOISY_LINES)
        oracle = self.oracle(ORACLE_TWO_LINES, budget=3)
        result = reduce_text(text, oracle)
        self.assertEqual(result.status, "BUDGET_EXCEEDED")
        self.assertEqual(result.checks, 3)
        self.assertIn("key-one", result.text)
        self.assertIn("key-two", result.text)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "gmin", *argv],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_reduce_end_to_end(self):
        input_path = write(self.tmp.name, "input.txt", "\n".join(NOISY_LINES))
        oracle_path = write(self.tmp.name, "oracle.py", ORACLE_TWO_LINES)
        out_path = os.path.join(self.tmp.name, "reduced.txt")
        proc = self.run_cli(
            "reduce", input_path,
            "--oracle", oracle_path,
            "--budget", "300",
            "--out", out_path,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        fields = dict(part.split("=", 1) for part in proc.stdout.split())
        self.assertEqual(fields["status"], "OK")
        with open(out_path, "rb") as fh:
            data = fh.read()
        self.assertEqual(data, b"key-one\nkey-two")
        self.assertEqual(int(fields["bytes"]), len(data))
        self.assertGreater(int(fields["checks"]), 0)
        self.assertLessEqual(int(fields["checks"]), 300)

    def test_budget_zero_via_cli(self):
        input_path = write(self.tmp.name, "input.txt", "\n".join(NOISY_LINES))
        oracle_path = write(self.tmp.name, "oracle.py", ORACLE_TWO_LINES)
        out_path = os.path.join(self.tmp.name, "reduced.txt")
        proc = self.run_cli(
            "reduce", input_path,
            "--oracle", oracle_path,
            "--budget", "0",
            "--out", out_path,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("status=BUDGET_EXCEEDED", proc.stdout)
        self.assertIn("checks=0", proc.stdout)
        with open(out_path, "rb") as fh:
            self.assertEqual(fh.read(), "\n".join(NOISY_LINES).encode("utf-8"))

    def test_missing_oracle_exits_2(self):
        input_path = write(self.tmp.name, "input.txt", "hello")
        out_path = os.path.join(self.tmp.name, "reduced.txt")
        proc = self.run_cli(
            "reduce", input_path,
            "--oracle", os.path.join(self.tmp.name, "nope.py"),
            "--budget", "10",
            "--out", out_path,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(out_path))

    def test_invalid_utf8_input_rejected(self):
        input_path = os.path.join(self.tmp.name, "input.txt")
        with open(input_path, "wb") as fh:
            fh.write(b"\xff\xfe invalid")
        oracle_path = write(self.tmp.name, "oracle.py", ORACLE_TWO_LINES)
        out_path = os.path.join(self.tmp.name, "reduced.txt")
        proc = self.run_cli(
            "reduce", input_path,
            "--oracle", oracle_path,
            "--budget", "10",
            "--out", out_path,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertFalse(os.path.exists(out_path))


if __name__ == "__main__":
    unittest.main()
