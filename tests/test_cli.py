import os
import subprocess
import sys
import tempfile
import unittest

from peepbc import run
from peepbc.asm import assemble
from peepbc.program import Program


def cli(*args, cwd=None):
    return subprocess.run(
        [sys.executable, "-m", "peepbc", *args],
        capture_output=True, text=True, cwd=cwd,
    )


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, name, prog, mapping=None):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(prog.to_bytes(mapping=mapping))
        return path

    def test_optimize_end_to_end_with_verify(self):
        prog = assemble(
            "CONST 2\nCONST 3\nADD\n"   # folds to CONST 5
            "CONST 0\nADD\n"            # identity, removed
            "JMP end\nCONST 9\n"        # dead CONST 9
            "end: HALT"
        )
        inp = self._write("in.bc", prog)
        out = os.path.join(self.dir, "out.bc")
        res = cli(inp, "-o", out, "--verify")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("verify: OK", res.stdout)
        self.assertIn("mapping (old_pc -> new_pc):", res.stdout)
        with open(out, "rb") as fh:
            opt, mapping = Program.from_bytes(fh.read())
        self.assertIsNotNone(mapping)
        self.assertEqual(len(opt.code), 3)  # CONST 5, JMP, HALT
        self.assertEqual(run(opt).stack, [5])
        self.assertEqual(run(opt).status, run(prog).status)

    def test_verify_failure_exit_7_no_output(self):
        # Acceptance D: 600 CONSTs pairwise folded with ADDs still leave a
        # 300-deep stack -> the rewrite is rejected, nothing is written.
        text = "\n".join(["CONST 1\nCONST 1\nADD"] * 300 + ["HALT"])
        prog = assemble(text)
        inp = self._write("big.bc", prog)
        out = os.path.join(self.dir, "big_out.bc")
        res = cli(inp, "-o", out, "--verify")
        self.assertEqual(res.returncode, 7, res.stdout + res.stderr)
        self.assertIn("verification failed", res.stderr)
        self.assertFalse(os.path.exists(out))

    def test_div_zero_preserved_through_cli(self):
        prog = assemble("CONST 0\nCONST 0\nDIV\nHALT")
        inp = self._write("dz.bc", prog)
        out = os.path.join(self.dir, "dz_out.bc")
        res = cli(inp, "-o", out, "--verify")
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(out, "rb") as fh:
            opt, _ = Program.from_bytes(fh.read())
        self.assertEqual(run(opt).status, "div_zero")

    def test_dump(self):
        prog = assemble("CONST 1\nHALT")
        inp = self._write("d.bc", prog)
        res = cli(inp, "--dump")
        self.assertEqual(res.returncode, 0)
        self.assertIn("CONST", res.stdout)
        self.assertIn("HALT", res.stdout)

    def test_asm_roundtrip(self):
        src = os.path.join(self.dir, "p.asm")
        with open(src, "w") as fh:
            fh.write("CONST 4\nCONST 2\nMUL\nHALT\n")
        out = os.path.join(self.dir, "p.bc")
        res = cli(src, "--asm", "-o", out)
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(out, "rb") as fh:
            prog, _ = Program.from_bytes(fh.read())
        self.assertEqual(run(prog).stack, [8])

    def test_missing_file_exit_2(self):
        res = cli(os.path.join(self.dir, "nope.bc"), "-o",
                  os.path.join(self.dir, "x.bc"))
        self.assertEqual(res.returncode, 2)


if __name__ == "__main__":
    unittest.main()
