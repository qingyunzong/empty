import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from peepbc import parse
from peepbc.cli import main

ROOT = Path(__file__).resolve().parent.parent

SRC = """\
# demo
consts:
0: 3
1: 4
code:
0: CONST 0
1: CONST 1
2: ADD
3: HALT
"""


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "in.bc").write_text(SRC)

    def tearDown(self):
        self.tmp.cleanup()

    def test_optimize_and_verify(self):
        out = self.dir / "out.bc"
        rc = main([str(self.dir / "in.bc"), "-o", str(out), "--verify"])
        self.assertEqual(rc, 0)
        text = out.read_text()
        self.assertIn("map:", text)
        prog = parse(text)
        self.assertEqual([i.op for i in prog.code], ["CONST", "HALT"])
        self.assertEqual(prog.consts[prog.code[0].arg], 7)

    def test_mapping_written(self):
        out = self.dir / "out.bc"
        main([str(self.dir / "in.bc"), "-o", str(out)])
        lines = [l for l in out.read_text().splitlines()
                 if l and not l.startswith("#")]
        map_idx = lines.index("map:")
        mapping = dict(
            tuple(map(int, l.split(":"))) for l in lines[map_idx + 1:]
        )
        # folded-away pcs map to the next executable point (the HALT)
        self.assertEqual(mapping, {0: 0, 1: 1, 2: 1, 3: 1})

    def test_verify_failure_exit_7_no_output(self):
        """Acceptance D via CLI: stack depth overflow -> exit 7, no file."""
        deep = self.dir / "deep.bc"
        code = "\n".join(f"{i}: CONST 0" for i in range(300))
        deep.write_text(f"consts:\n0: 1\ncode:\n{code}\n300: HALT\n")
        out = self.dir / "nope.bc"
        rc = main([str(deep), "-o", str(out), "--verify"])
        self.assertEqual(rc, 7)
        self.assertFalse(out.exists())

    def test_module_invocation(self):
        out = self.dir / "out2.bc"
        proc = subprocess.run(
            [sys.executable, "-m", "peepbc",
             str(self.dir / "in.bc"), "-o", str(out), "--verify"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("verification OK", proc.stdout)
        self.assertTrue(out.exists())

    def test_module_invocation_exit_7(self):
        deep = self.dir / "deep.bc"
        code = "\n".join(f"{i}: CONST 0" for i in range(300))
        deep.write_text(f"consts:\n0: 1\ncode:\n{code}\n300: HALT\n")
        out = self.dir / "nope2.bc"
        proc = subprocess.run(
            [sys.executable, "-m", "peepbc", str(deep), "-o", str(out)],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 7)
        self.assertFalse(out.exists())

    def test_parse_error_exit_1(self):
        bad = self.dir / "bad.bc"
        bad.write_text("code:\n0: BOGUS\n")
        rc = main([str(bad), "-o", str(self.dir / "x.bc")])
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
