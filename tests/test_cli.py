import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OK_SRC = """\
# tiny program: push two ints, compare, branch
CONST_INT 3
CONST_INT 4
CMP
JZ 5
HALT
HALT
"""

TYPEFAULT_SRC = """\
CONST_INT 5
JZ 2
HALT
"""

JOINERROR_SRC = """\
CONST_BOOL true
JZ 4
CONST_INT 1
JMP 6
CONST_INT 2
CONST_INT 3
HALT
"""

DEAD_SRC = """\
CONST_BOOL true
JZ 3
HALT
HALT
ADD
"""

VERIFYERROR_SRC = "JMP 42\n"


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "typedbc", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class CliTest(unittest.TestCase):
    def run_program(self, src):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".tbc", delete=False
        ) as handle:
            handle.write(src)
            path = handle.name
        try:
            return run_cli(path, "--check")
        finally:
            os.unlink(path)

    def test_success_outputs_blocks_json(self):
        proc = self.run_program(OK_SRC)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["max_stack_height"], 32)
        starts = [block["start"] for block in payload["blocks"]]
        self.assertEqual(starts, [0, 4, 5])
        entry = payload["blocks"][0]
        self.assertTrue(entry["reachable"])
        self.assertEqual(entry["in"], [])
        self.assertEqual(entry["out"], [])
        self.assertEqual(entry["successors"], [4, 5])
        self.assertEqual(payload["warnings"], [])

    def test_typefault_exits_12(self):
        proc = self.run_program(TYPEFAULT_SRC)
        self.assertEqual(proc.returncode, 12)
        self.assertIn("TypeFault", proc.stderr)
        self.assertIn("pc 1", proc.stderr)

    def test_joinerror_exits_12(self):
        proc = self.run_program(JOINERROR_SRC)
        self.assertEqual(proc.returncode, 12)
        self.assertIn("JoinError", proc.stderr)

    def test_verifyerror_exits_12(self):
        proc = self.run_program(VERIFYERROR_SRC)
        self.assertEqual(proc.returncode, 12)
        self.assertIn("VerifyError", proc.stderr)

    def test_dead_type_warning_still_exit_0(self):
        # Acceptance case D at the CLI level.
        proc = self.run_program(DEAD_SRC)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("DeadType", proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(len(payload["warnings"]), 1)
        self.assertEqual(payload["warnings"][0]["kind"], "DeadType")
        self.assertEqual(payload["warnings"][0]["pc"], 4)

    def test_missing_file_exits_2(self):
        proc = run_cli("/nonexistent/path.tbc", "--check")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
