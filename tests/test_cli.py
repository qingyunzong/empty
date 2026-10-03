"""End-to-end tests of the JSON command line interface."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "filepatch", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = {
            "files": [
                {"path": "a", "type": "file", "lines": ["1"]},
                {"path": "b", "type": "file", "lines": ["2"]},
                {"path": "old", "type": "file", "lines": ["x", "y"]},
            ]
        }
        self.target = {
            "files": [
                {"path": "a", "type": "file", "lines": ["2"]},
                {"path": "b", "type": "file", "lines": ["1"]},
                {"path": "new", "type": "file", "lines": ["x", "y", "z"]},
            ]
        }
        self.a_path = self._write("a.json", self.source)
        self.b_path = self._write("b.json", self.target)

    def _write(self, name, obj):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(obj, handle)
        return path

    def _read(self, name):
        with open(os.path.join(self.tmp.name, name), encoding="utf-8") as handle:
            return json.load(handle)

    def test_diff_apply_verify_invert(self):
        patch_path = os.path.join(self.tmp.name, "patch.json")
        result = run_cli("diff", self.a_path, self.b_path, "--out", patch_path)
        self.assertEqual(result.returncode, 0, result.stderr)

        result = run_cli("verify", self.a_path, self.b_path, patch_path)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(json.loads(result.stdout)["ok"])

        out_path = os.path.join(self.tmp.name, "out.json")
        result = run_cli("apply", self.a_path, patch_path, "--out", out_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self._read("out.json"), self.target)

        inv_path = os.path.join(self.tmp.name, "inv.json")
        result = run_cli("invert", patch_path, "--out", inv_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        back_path = os.path.join(self.tmp.name, "back.json")
        result = run_cli("apply", out_path, inv_path, "--out", back_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self._read("back.json"), self.source)

    def test_diff_to_stdout(self):
        result = run_cli("diff", self.a_path, self.b_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        patch = json.loads(result.stdout)
        self.assertEqual(patch["format"], "filepatch-1")
        self.assertIn("certificate", patch)
        self.assertIsInstance(patch["cost"], int)

    def test_verify_rejects_tampered_certificate(self):
        patch_path = os.path.join(self.tmp.name, "patch.json")
        self.assertEqual(
            run_cli("diff", self.a_path, self.b_path, "--out", patch_path).returncode,
            0,
        )
        patch = self._read("patch.json")
        patch["certificate"]["cost"] += 1
        self._write("patch.json", patch)
        result = run_cli("verify", self.a_path, self.b_path, patch_path)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["ok"])

    def test_apply_rejects_wrong_tree(self):
        patch_path = os.path.join(self.tmp.name, "patch.json")
        self.assertEqual(
            run_cli("diff", self.a_path, self.b_path, "--out", patch_path).returncode,
            0,
        )
        result = run_cli("apply", self.b_path, patch_path)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
