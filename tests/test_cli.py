import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

import _path  # noqa: F401

from rule_engine.cli import main


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(["--state", self.state, *argv])
        return code, out.getvalue(), err.getvalue()

    def test_full_session(self):
        self.assertEqual(self.run_cli("assert", "a")[0], 0)
        self.assertEqual(self.run_cli("rule", "b:-a")[0], 0)
        self.assertEqual(self.run_cli("rule", "c:-b,not x")[0], 0)
        code, out, _ = self.run_cli("derive", "c")
        self.assertEqual((code, out.strip()), (0, "true"))
        self.assertEqual(self.run_cli("assert", "x")[0], 0)
        code, out, _ = self.run_cli("derive", "c")
        self.assertEqual((code, out.strip()), (1, "false"))
        self.assertEqual(self.run_cli("retract", "x")[0], 0)
        code, out, _ = self.run_cli("derive", "c")
        self.assertEqual((code, out.strip()), (0, "true"))

    def test_assert_derived_exit_6(self):
        self.assertEqual(self.run_cli("assert", "a")[0], 0)
        self.assertEqual(self.run_cli("rule", "d:-a")[0], 0)
        code, _, err = self.run_cli("assert", "d")
        self.assertEqual(code, 6)
        self.assertIn("derived", err)

    def test_rule_syntax_exit_2(self):
        for bad in (":-a", "d:-a,,b", "d:-not", "d:-", ""):
            code, _, _ = self.run_cli("rule", bad)
            self.assertEqual(code, 2, msg=bad)

    def test_unknown_predicate_allowed(self):
        self.assertEqual(self.run_cli("assert", "mystery_pred")[0], 0)
        code, out, _ = self.run_cli("derive", "mystery_pred")
        self.assertEqual((code, out.strip()), (0, "true"))
        code, out, _ = self.run_cli("derive", "absent_pred")
        self.assertEqual((code, out.strip()), (1, "false"))

    def test_retract_derived_fails(self):
        self.run_cli("assert", "a")
        self.run_cli("rule", "d:-a")
        self.assertEqual(self.run_cli("retract", "d")[0], 1)
        self.assertEqual(self.run_cli("retract", "ghost")[0], 1)

    def test_double_proof_via_cli(self):
        self.run_cli("assert", "a")
        self.run_cli("assert", "b")
        self.run_cli("rule", "d:-a")
        self.run_cli("rule", "d:-b")
        self.run_cli("retract", "a")
        code, out, _ = self.run_cli("derive", "d")
        self.assertEqual((code, out.strip()), (0, "true"))
        self.run_cli("retract", "b")
        code, out, _ = self.run_cli("derive", "d")
        self.assertEqual((code, out.strip()), (1, "false"))

    def test_facts_listing(self):
        self.run_cli("assert", "a")
        self.run_cli("rule", "b:-a")
        code, out, _ = self.run_cli("facts")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), ["a\tbase", "b\tderived"])

    def test_state_persists_across_invocations(self):
        self.run_cli("assert", "keep_me")
        code, out, _ = self.run_cli("derive", "keep_me")
        self.assertEqual((code, out.strip()), (0, "true"))


if __name__ == "__main__":
    unittest.main()
