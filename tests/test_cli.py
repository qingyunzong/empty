import io
import subprocess
import sys
import unittest
from pathlib import Path

from rule_engine.cli import main

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_cli(script):
    """Feed a script (string with newlines) to the CLI, return (code, out)."""
    out = io.StringIO()
    code = main(argv=[], stdin=io.StringIO(script), stdout=out)
    return code, out.getvalue()


class TestCliCommands(unittest.TestCase):
    def test_session_roundtrip(self):
        code, out = run_cli(
            "rule p:-a,not b\n"
            "assert a\n"
            "derive p\n"
            "assert b\n"
            "derive p\n"
            "retract b\n"
            "derive p\n"
        )
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(
            lines, ["ok 0", "ok", "yes", "ok", "no", "ok", "yes"]
        )

    def test_derive_unknown_predicate_allowed(self):
        code, out = run_cli("derive never_seen\n")
        self.assertEqual(code, 1)
        self.assertEqual(out.strip(), "no")

    def test_assert_derived_exits_6(self):
        code, out = run_cli("rule p:-a\nassert a\nassert p\n")
        self.assertEqual(code, 6)

    def test_rule_syntax_error_exits_2(self):
        for bad in ["rule p\n", "rule :-a\n", "rule p:-a,,b\n", "rule\n"]:
            code, _ = run_cli(bad)
            self.assertEqual(code, 2, msg=bad)

    def test_unknown_command_exits_2(self):
        code, _ = run_cli("frobnicate x\n")
        self.assertEqual(code, 2)

    def test_bad_fact_argument_exits_2(self):
        code, _ = run_cli("assert\n")
        self.assertEqual(code, 2)
        code, _ = run_cli("derive 1bad\n")
        self.assertEqual(code, 2)

    def test_comments_and_blank_lines(self):
        code, out = run_cli("# comment\n\nassert a\n# derive a\n")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "ok")

    def test_single_command_argv_mode(self):
        out = io.StringIO()
        code = main(argv=["assert", "a"], stdout=out)
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue().strip(), "ok")


class TestCliSubprocess(unittest.TestCase):
    def run_module(self, args, stdin_text=""):
        return subprocess.run(
            [sys.executable, "-m", "rule_engine", *args],
            input=stdin_text,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )

    def test_stdin_session(self):
        proc = self.run_module(
            [], "rule q:-p\nassert p\nderive q\nretract p\nderive q\n"
        )
        self.assertEqual(proc.returncode, 1)  # last derive answered "no"
        self.assertEqual(
            proc.stdout.splitlines(), ["ok 0", "ok", "yes", "ok", "no"]
        )

    def test_one_shot_derive_exit_codes(self):
        proc = self.run_module(["derive", "nothing"])
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout.strip(), "no")

    def test_one_shot_assert_derived_exit_6(self):
        proc = self.run_module(
            [], "rule p:-a\nassert a\nassert p\n"
        )
        self.assertEqual(proc.returncode, 6)
        self.assertIn("derived", proc.stderr)

    def test_one_shot_rule_syntax_exit_2(self):
        proc = self.run_module(["rule", "p"])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr)


if __name__ == "__main__":
    unittest.main()
