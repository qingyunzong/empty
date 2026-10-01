import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(cwd, *args):
    env = dict(os.environ)
    env["PYTHONPATH"] = ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "mtc", *args],
        cwd=cwd, capture_output=True, text=True, env=env,
    )


def write(d, name, content):
    with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
        fh.write(content)


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.proj = os.path.join(self.tmp.name, "proj")
        os.mkdir(self.proj)

    def load(self):
        return run_cli(self.tmp.name, "load", self.proj)

    def patch(self, name):
        return run_cli(self.tmp.name, "patch", os.path.join(self.proj, name))

    def check(self):
        return run_cli(self.tmp.name, "check")

    def state(self):
        with open(os.path.join(self.tmp.name, ".mtc_state.json"), encoding="utf-8") as fh:
            return json.load(fh)


class TestAcceptanceA(CliTestCase):
    """Changing an interface only affects importers; unrelated diagnostics
    keep their exact file:line:code identity."""

    def test_interface_change_ripple(self):
        write(self.proj, "a.mt", "fn f(a: Int) -> Int = a + 1\n")
        write(self.proj, "b.mt", "import a\nlet y = f(1)\n")
        write(self.proj, "c.mt", "let z: Int = true\n")
        r = self.load()
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(r.stdout.strip(), "c.mt:1:E_TYPE: 'z' annotated as Int "
                                           "but initializer has type Bool")

        write(self.proj, "a.mt", "fn f(a: Bool) -> Int = 1\n")
        r = self.patch("a.mt")
        self.assertEqual(r.returncode, 1, r.stderr)
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith("b.mt:2:E_TYPE:"), lines)
        # c.mt's diagnostic is byte-identical before and after the patch.
        self.assertEqual(lines[1], "c.mt:1:E_TYPE: 'z' annotated as Int "
                                   "but initializer has type Bool")
        self.assertNotIn("a.mt", r.stdout)


class TestAcceptanceB(CliTestCase):
    """A broken module does not pollute independent modules."""

    def test_bad_module_isolated(self):
        write(self.proj, "bad.mt", "let x: Int = true\nlet q = nope\n")
        write(self.proj, "good.mt", "let y: Int = 1\nlet w = y + 2\n")
        r = self.load()
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertNotIn("good.mt", r.stdout)
        self.assertIn("bad.mt:1:E_TYPE", r.stdout)
        self.assertIn("bad.mt:2:E_NAME", r.stdout)

        write(self.proj, "good.mt", "let y: Int = 3\nlet w = y + 4\n")
        r = self.patch("good.mt")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertNotIn("good.mt", r.stdout)
        self.assertEqual(len(r.stdout.strip().splitlines()), 2)


class TestAcceptanceC(CliTestCase):
    """Import cycles fail the whole load atomically (exit 3, no state)."""

    def test_load_cycle_atomic(self):
        write(self.proj, "x.mt", "import y\nlet a = 1\n")
        write(self.proj, "y.mt", "import x\nlet b = 2\n")
        r = self.load()
        self.assertEqual(r.returncode, 3)
        self.assertIn("cycle", r.stderr)
        self.assertFalse(
            os.path.exists(os.path.join(self.tmp.name, ".mtc_state.json")))

    def test_patch_cycle_atomic(self):
        write(self.proj, "a.mt", "let a = 1\n")
        write(self.proj, "b.mt", "import a\nlet b = a + 1\n")
        r = self.load()
        self.assertEqual(r.returncode, 0, r.stderr)
        before = self.state()

        write(self.proj, "a.mt", "import b\nlet a = 1\n")
        r = self.patch("a.mt")
        self.assertEqual(r.returncode, 3)
        self.assertIn("cycle", r.stderr)
        self.assertEqual(self.state(), before)  # state untouched

        # check re-reads the disk, still sees the cycle, fails atomically too.
        r = self.check()
        self.assertEqual(r.returncode, 3)
        self.assertEqual(self.state(), before)

        # reverting the file makes the project loadable again
        write(self.proj, "a.mt", "let a = 1\n")
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_self_import_cycle(self):
        write(self.proj, "s.mt", "import s\nlet a = 1\n")
        r = self.load()
        self.assertEqual(r.returncode, 3)


class TestPatchSemantics(CliTestCase):
    def test_noop_patch(self):
        write(self.proj, "a.mt", "let a = 1\n")
        r = self.load()
        self.assertEqual(r.returncode, 0, r.stderr)
        before = self.state()
        r = self.patch("a.mt")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "no-op")
        self.assertEqual(self.state(), before)

    def test_patch_new_module_fixes_missing_import(self):
        write(self.proj, "a.mt", "import b\nlet x = bval + 1\n")
        r = self.load()
        self.assertEqual(r.returncode, 1)
        self.assertIn("a.mt:1:E_NAME", r.stdout)
        write(self.proj, "b.mt", "let bval = 41\n")
        r = self.patch("b.mt")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.strip(), "")

    def test_patch_outside_project_rejected(self):
        write(self.proj, "a.mt", "let a = 1\n")
        self.assertEqual(self.load().returncode, 0)
        other = os.path.join(self.tmp.name, "other.mt")
        write(self.tmp.name, "other.mt", "let o = 1\n")
        r = run_cli(self.tmp.name, "patch", other)
        self.assertEqual(r.returncode, 2)

    def test_check_without_load_fails(self):
        r = run_cli(self.tmp.name, "check")
        self.assertEqual(r.returncode, 2)

    def test_usage_error(self):
        r = run_cli(self.tmp.name)
        self.assertEqual(r.returncode, 2)

    def test_diagnostics_sorted(self):
        write(self.proj, "z.mt", "let q = missing\n")
        write(self.proj, "a.mt", "let x: Int = true\nlet y = also_missing\n")
        r = self.load()
        lines = r.stdout.strip().splitlines()
        keys = [tuple(line.split(":")[:3]) for line in lines]
        self.assertEqual(keys, sorted(keys))
        self.assertTrue(lines[0].startswith("a.mt:1:E_TYPE"))
        self.assertTrue(lines[1].startswith("a.mt:2:E_NAME"))
        self.assertTrue(lines[2].startswith("z.mt:1:E_NAME"))


if __name__ == "__main__":
    unittest.main()
