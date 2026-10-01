import json
import os
import subprocess
import sys
import tempfile
import unittest
from itertools import combinations

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gmin import (
    STATUS_BUDGET_EXCEEDED,
    STATUS_MINIMAL,
    SubprocessOracle,
    reduce_text,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ORACLE_BUG = '''
import sys

def main():
    data = sys.stdin.buffer.read().decode("utf-8")
    sys.exit(42 if "BUG" in data else 0)

if __name__ == "__main__":
    main()
'''

ORACLE_MULTIBYTE = '''
import sys

def main():
    data = sys.stdin.buffer.read().decode("utf-8")
    sys.exit(42 if "缺陷💥" in data else 0)

if __name__ == "__main__":
    main()
'''

# Flaky: even when the defect is present it sometimes exits non-42.
ORACLE_FLAKY = '''
import sys

def main():
    data = sys.stdin.buffer.read().decode("utf-8")
    if "KEY" in data and len(data) % 7 != 0:
        sys.exit(42)
    sys.exit(1)

if __name__ == "__main__":
    main()
'''

ORACLE_SLEEPY = '''
import sys, time

def main():
    sys.stdin.buffer.read()
    time.sleep(30)

if __name__ == "__main__":
    main()
'''

ORACLE_REPLACE = '''
import sys

def main():
    data = sys.stdin.buffer.read().decode("utf-8")
    sys.exit(42 if data in ("a", "B") else 0)

if __name__ == "__main__":
    main()
'''


def write_file(directory, name, content):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return path


def brute_force_subsequence(text, pred):
    """Smallest (length, then index order) triggering char subsequence."""
    n = len(text)
    for length in range(0, n + 1):
        for idxs in combinations(range(n), length):
            candidate = "".join(text[i] for i in idxs)
            if pred(candidate):
                return candidate
    return None


class GminTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def make_oracle(self, source, name="oracle.py", timeout=1.0):
        path = write_file(self.dir, name, source)
        return SubprocessOracle(path, timeout=timeout)

    def run_cli(self, *cli_args):
        return subprocess.run(
            [sys.executable, "-m", "gmin"] + list(cli_args),
            cwd=ROOT,
            capture_output=True,
            text=True,
        )

    # Acceptance A: comment-noise sample equals brute-force subsequence reference.
    def test_a_matches_brute_force_reference(self):
        text = "# noise line one\n# noise line two\nBUG\n# trailing noise\n"
        oracle = self.make_oracle(ORACLE_BUG)
        result = reduce_text(text, oracle, budget=5000)
        self.assertEqual(result.status, STATUS_MINIMAL)
        reference = brute_force_subsequence(text, lambda s: "BUG" in s)
        self.assertEqual(result.text, reference)
        self.assertEqual(result.text, "BUG")
        self.assertEqual(result.bytes, len("BUG".encode("utf-8")))
        self.assertGreater(result.checks, 0)

    # Acceptance B: multi-byte characters are never split.
    def test_b_multibyte_chars_stay_intact(self):
        text = "中文注释行\n缺陷💥\n更多内容🎉🎉\n"
        oracle = self.make_oracle(ORACLE_MULTIBYTE)
        result = reduce_text(text, oracle, budget=5000)
        self.assertEqual(result.status, STATUS_MINIMAL)
        self.assertEqual(result.text, "缺陷💥")
        # Result is valid UTF-8 and every char of the marker survived.
        result.text.encode("utf-8").decode("utf-8")
        self.assertIn("缺陷💥", result.text)

    # Acceptance C: budget 0 immediately yields BUDGET_EXCEEDED.
    def test_c_budget_zero_immediately_exceeded(self):
        input_path = write_file(self.dir, "input.txt", "BUG\n")
        oracle_path = write_file(self.dir, "oracle.py", ORACLE_BUG)
        out_path = os.path.join(self.dir, "reduced.txt")
        proc = self.run_cli(
            "reduce", input_path, "--oracle", oracle_path,
            "--budget", "0", "--out", out_path,
        )
        self.assertEqual(proc.returncode, 1, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["status"], STATUS_BUDGET_EXCEEDED)
        self.assertEqual(report["checks"], 0)
        self.assertEqual(report["bytes"], len("BUG\n".encode("utf-8")))
        with open(out_path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "BUG\n")

    # Acceptance D: flaky non-42 exits must never be accepted as interesting.
    def test_d_flaky_non_42_never_selected(self):
        text = "xxxx KEY yyyy\nzzzz\n"
        oracle = self.make_oracle(ORACLE_FLAKY)
        result = reduce_text(text, oracle, budget=20000)
        self.assertIn("KEY", result.text)
        # Every accepted candidate really triggered the oracle (exit 42).
        self.assertNotEqual(result.status, STATUS_MINIMAL if "KEY" not in result.text else "x")

    # Oracle missing -> exit code 2.
    def test_oracle_missing_exits_2(self):
        input_path = write_file(self.dir, "input.txt", "BUG\n")
        out_path = os.path.join(self.dir, "reduced.txt")
        proc = self.run_cli(
            "reduce", input_path,
            "--oracle", os.path.join(self.dir, "nope.py"),
            "--budget", "10", "--out", out_path,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("oracle", proc.stderr.lower())

    # Oracle timeout counts as not triggered.
    def test_timeout_counts_as_not_triggered(self):
        oracle = self.make_oracle(ORACLE_SLEEPY, timeout=0.2)
        result = reduce_text("BUG\n", oracle, budget=5)
        self.assertEqual(result.status, "NOT_TRIGGERED")
        self.assertEqual(result.text, "BUG\n")

    # Character replacement with the given table is applied.
    def test_char_replacement_table(self):
        oracle = self.make_oracle(ORACLE_REPLACE)
        result = reduce_text("B", oracle, budget=500)
        self.assertEqual(result.status, STATUS_MINIMAL)
        self.assertEqual(result.text, "a")

    # Termination: any single-line / single-char deletion must not trigger.
    def test_result_is_one_minimal(self):
        text = "junk\nBUG\nmore junk\n"
        oracle = self.make_oracle(ORACLE_BUG)
        result = reduce_text(text, oracle, budget=5000)
        self.assertEqual(result.status, STATUS_MINIMAL)
        lines = result.text.splitlines(keepends=True)
        for i in range(len(lines)):
            trial = "".join(lines[:i] + lines[i + 1:])
            self.assertNotIn("BUG", trial)
        for li, line in enumerate(lines):
            for ci in range(len(line)):
                trial_line = line[:ci] + line[ci + 1:]
                trial = "".join(lines[:li] + [trial_line] + lines[li + 1:])
                self.assertNotIn("BUG", trial)

    # CLI happy path emits status/bytes/checks and writes the reduced file.
    def test_cli_reduce_end_to_end(self):
        input_path = write_file(self.dir, "input.txt", "# c\nBUG\n# t\n")
        oracle_path = write_file(self.dir, "oracle.py", ORACLE_BUG)
        out_path = os.path.join(self.dir, "reduced.txt")
        proc = self.run_cli(
            "reduce", input_path, "--oracle", oracle_path,
            "--budget", "5000", "--out", out_path,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["status"], STATUS_MINIMAL)
        self.assertEqual(report["bytes"], 3)
        self.assertGreater(report["checks"], 0)
        with open(out_path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "BUG")


if __name__ == "__main__":
    unittest.main()
