"""CLI 冒烟：pack -> select 列子集 -> info。"""

import io
import os
import subprocess
import sys
import tempfile
import unittest


class TestCli(unittest.TestCase):
    def run_cli(self, *args, stdin=None):
        return subprocess.run(
            [sys.executable, "-m", "colbit", *args],
            input=stdin, capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def test_pack_select_info(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "t.clb")
            csv_in = "1,100,7\n0,200,8\n1,300,9\n"
            with open(path, "wb") as f:
                r = self.run_cli("pack", "--widths", "1,9,4", "-o", path,
                                 stdin=csv_in)
            self.assertEqual(r.returncode, 0, r.stderr)

            r = self.run_cli("select", path, "--cols", "2,0", "--batch", "2")
            self.assertEqual(r.returncode, 0, r.stderr)
            lines = [l for l in r.stdout.splitlines() if l]
            self.assertEqual(lines, ["2,0", "7,1", "8,0", "9,1"])

            r = self.run_cli("info", path)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("columns=3 rows=3", r.stdout)

    def test_select_default_all_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "t.clb")
            with open(path, "wb") as f:
                r = self.run_cli("pack", "--widths", "7,32", "-o", path,
                                 stdin="5,4294967295\n")
            self.assertEqual(r.returncode, 0, r.stderr)
            r = self.run_cli("select", path)
            self.assertEqual(r.returncode, 0, r.stderr)
            lines = [l for l in r.stdout.splitlines() if l]
            self.assertEqual(lines, ["0,1", "5,4294967295"])


if __name__ == "__main__":
    unittest.main()
