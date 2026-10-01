"""End-to-end CLI tests: load / check / patch semantics."""
import os
import tempfile
import unittest

from common import (
    diag_set,
    parse_diagnostics,
    parse_rechecked,
    read_state,
    run_cli,
    state_diag_entries,
    write_file,
    write_project,
)


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = self.tmp.name
        self.proj = os.path.join(self.cwd, "proj")

    def load(self, files):
        write_project(self.proj, files)
        return run_cli(["load", "proj"], cwd=self.cwd)


class TestLoad(CliTestCase):
    def test_clean_project(self):
        result = self.load({
            "base.mm": "fun inc(a: Int) -> Int = a + 1\nlet ten: Int = 10\n",
            "user.mm": "import base\nlet x: Int = inc(ten)\nlet y = x + 1\n",
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("loaded 2 module(s)", result.stdout)
        self.assertIn("OK: no diagnostics", result.stdout)

    def test_parse_error(self):
        result = self.load({"a.mm": "let x: Int = \n"})
        self.assertEqual(result.returncode, 1)
        diags = parse_diagnostics(result.stdout)
        self.assertEqual(diags[0]["code"], "E_PARSE")
        self.assertEqual(diags[0]["line"], 1)

    def test_name_and_type_errors(self):
        result = self.load({
            "a.mm": "let y = missing + 1\n",
            "b.mm": "fun f(a: Int) -> Int = a\nlet z = f(1, 2)\n",
        })
        self.assertEqual(result.returncode, 1)
        codes = {d["code"] for d in parse_diagnostics(result.stdout)}
        self.assertEqual(codes, {"E_NAME", "E_TYPE"})

    def test_diagnostics_sorted_by_file_line_code(self):
        result = self.load({
            "b.mm": "let q = u1 + 1\nlet p = u0 + 1\n",
            "a.mm": "let r = u2 + 1\nfun f(a: Int) -> Int = a\nlet s = f(1, 2)\n",
        })
        self.assertEqual(result.returncode, 1)
        diags = parse_diagnostics(result.stdout)
        keys = [(d["file"], d["line"], d["code"]) for d in diags]
        self.assertEqual(keys, sorted(keys))
        self.assertGreaterEqual(len(diags), 4)

    def test_cycle_fails_atomically_exit3(self):
        # First load a good project, then break it with a cycle: the failed
        # load must not touch the previously saved state.
        good = {"a.mm": "let x: Int = 1\n", "b.mm": "import a\nlet y = x + 1\n"}
        result = self.load(good)
        self.assertEqual(result.returncode, 0, result.stderr)
        state_path = os.path.join(self.cwd, ".mmcheck.json")
        with open(state_path, "rb") as fh:
            saved = fh.read()

        write_file(os.path.join(self.proj, "a.mm"), "import b\nlet x: Int = 1\n")
        result = run_cli(["load", "proj"], cwd=self.cwd)
        self.assertEqual(result.returncode, 3)
        self.assertIn("import cycle", result.stderr)
        with open(state_path, "rb") as fh:
            self.assertEqual(fh.read(), saved)  # state untouched

    def test_self_import_cycle(self):
        result = self.load({"a.mm": "import a\nlet x = 1\n"})
        self.assertEqual(result.returncode, 3)


class TestIsolation(CliTestCase):
    def test_bad_module_does_not_pollute_independent_module(self):
        result = self.load({
            "bad.mm": "let z: Int = nope +\n",
            "good.mm": "fun inc(a: Int) -> Int = a + 1\nlet x: Int = inc(1)\n",
            "dependent.mm": "import bad\nlet w = z + 1\n",
        })
        self.assertEqual(result.returncode, 1)
        diags = parse_diagnostics(result.stdout)
        by_file = {}
        for d in diags:
            by_file.setdefault(d["file"], []).append(d)
        self.assertNotIn("good.mm", by_file)          # independent module passes
        self.assertIn("bad.mm", by_file)              # the broken module itself
        self.assertIn("dependent.mm", by_file)        # its dependent sees fallout
        self.assertTrue(all(d["code"] == "E_PARSE" for d in by_file["bad.mm"]))
        self.assertTrue(all(d["code"] == "E_NAME" for d in by_file["dependent.mm"]))


class TestPatch(CliTestCase):
    FILES = {
        "base.mm": "fun inc(a: Int) -> Int = a + 1\n",
        "user1.mm": "import base\nlet u1: Int = inc(1)\n",
        "user2.mm": "import base\nlet u2: Int = inc(2)\n",
        "indep.mm": "let v = unknown_name + 1\n",
    }

    def test_interface_change_only_affects_importers(self):
        result = self.load(self.FILES)
        self.assertEqual(result.returncode, 1)  # indep.mm has an E_NAME
        before = read_state(self.cwd)
        indep_before = state_diag_entries(before, "indep")

        write_file(os.path.join(self.proj, "base.mm"),
                   "fun inc(a: Int, b: Int) -> Int = a + b\n")
        result = run_cli(["patch", "proj/base.mm"], cwd=self.cwd)
        self.assertEqual(result.returncode, 1)

        # Only base and its importers were re-checked.
        self.assertEqual(parse_rechecked(result.stdout), {"base", "user1", "user2"})

        diags = parse_diagnostics(result.stdout)
        by_file = {}
        for d in diags:
            by_file.setdefault(d["file"], []).append(d)
        self.assertEqual(by_file["user1.mm"][0]["code"], "E_TYPE")
        self.assertEqual(by_file["user2.mm"][0]["code"], "E_TYPE")

        # The independent module's diagnostic kept its id (序号不变).
        after = read_state(self.cwd)
        self.assertEqual(state_diag_entries(after, "indep"), indep_before)
        indep_id = indep_before[0][0]
        self.assertEqual(by_file["indep.mm"][0]["id"], indep_id)

    def test_noop_patch(self):
        result = self.load(self.FILES)
        self.assertEqual(result.returncode, 1)
        before = read_state(self.cwd)

        result = run_cli(["patch", "proj/user1.mm"], cwd=self.cwd)
        self.assertIn("no-op", result.stdout)
        after = read_state(self.cwd)
        self.assertEqual(before, after)  # state fully unchanged

    def test_patch_fixes_error(self):
        result = self.load(self.FILES)
        self.assertEqual(result.returncode, 1)
        write_file(os.path.join(self.proj, "indep.mm"), "let v: Int = 1\n")
        result = run_cli(["patch", "proj/indep.mm"], cwd=self.cwd)
        self.assertEqual(result.returncode, 0)
        self.assertIn("OK: no diagnostics", result.stdout)
        self.assertEqual(parse_rechecked(result.stdout), {"indep"})

    def test_patch_introducing_cycle_fails_atomically(self):
        result = self.load(self.FILES)
        self.assertEqual(result.returncode, 1)
        before = read_state(self.cwd)

        write_file(os.path.join(self.proj, "base.mm"),
                   "import user1\nfun inc(a: Int) -> Int = a + 1\n")
        result = run_cli(["patch", "proj/base.mm"], cwd=self.cwd)
        self.assertEqual(result.returncode, 3)
        self.assertIn("import cycle", result.stderr)
        self.assertEqual(read_state(self.cwd), before)  # state untouched

    def test_patch_unknown_module_import_recovers_when_module_added(self):
        result = self.load({"a.mm": "import helper\nlet x: Int = 1\n"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(parse_diagnostics(result.stdout)[0]["code"], "E_NAME")
        # Adding the missing module via patch heals the importer.
        write_file(os.path.join(self.proj, "helper.mm"), "let h: Int = 1\n")
        result = run_cli(["patch", "proj/helper.mm"], cwd=self.cwd)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(parse_rechecked(result.stdout), {"a", "helper"})


class TestCheck(CliTestCase):
    def test_check_requires_load(self):
        result = run_cli(["check"], cwd=self.cwd)
        self.assertEqual(result.returncode, 2)

    def test_check_full_recheck_matches_patch(self):
        result = self.load(TestPatch.FILES)
        self.assertEqual(result.returncode, 1)
        write_file(os.path.join(self.proj, "base.mm"),
                   "fun inc(a: Int, b: Int) -> Int = a + b\n")
        patch_result = run_cli(["patch", "proj/base.mm"], cwd=self.cwd)
        check_result = run_cli(["check"], cwd=self.cwd)
        self.assertEqual(check_result.returncode, 1)
        self.assertEqual(
            diag_set(parse_diagnostics(patch_result.stdout)),
            diag_set(parse_diagnostics(check_result.stdout)),
        )


if __name__ == "__main__":
    unittest.main()
