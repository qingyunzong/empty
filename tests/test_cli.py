import json
import os
import subprocess
import sys
import tempfile
import unittest

from patchtool import FileTree

OLD = FileTree({"a": ("x1", "x2"), "b": ("y",), "c": ("z",)})
NEW = FileTree({"a": ("y",), "d": ("x1", "x2"), "e/f": ("z", "w")})


def run_cli(*argv, cwd=None):
    return subprocess.run([sys.executable, "-m", "patchtool", *argv],
                          capture_output=True, text=True, cwd=cwd)


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old_path = os.path.join(self.tmp.name, "old.json")
        self.new_path = os.path.join(self.tmp.name, "new.json")
        self.patch_path = os.path.join(self.tmp.name, "patch.json")
        self.out_path = os.path.join(self.tmp.name, "out.json")
        with open(self.old_path, "w") as fh:
            json.dump(OLD.to_dict(), fh)
        with open(self.new_path, "w") as fh:
            json.dump(NEW.to_dict(), fh)

    def test_diff_apply_verify_round_trip(self):
        r = run_cli("diff", self.old_path, self.new_path,
                    "-o", self.patch_path)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.patch_path) as fh:
            patch = json.load(fh)
        self.assertEqual(patch["version"], 1)
        self.assertIsInstance(patch["cost"], int)
        self.assertGreaterEqual(patch["cost"], 0)

        r = run_cli("apply", self.old_path, self.patch_path,
                    "-o", self.out_path)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.out_path) as fh:
            result = FileTree.from_dict(json.load(fh))
        self.assertEqual(result, NEW)

        r = run_cli("verify", self.old_path, self.new_path, self.patch_path)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertTrue(json.loads(r.stdout)["valid"])

    def test_verify_rejects_tampered_patch(self):
        r = run_cli("diff", self.old_path, self.new_path,
                    "-o", self.patch_path)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.patch_path) as fh:
            patch = json.load(fh)
        patch["certificate"]["cost"] += 1
        with open(self.patch_path, "w") as fh:
            json.dump(patch, fh)
        r = run_cli("verify", self.old_path, self.new_path, self.patch_path)
        self.assertEqual(r.returncode, 1)
        self.assertFalse(json.loads(r.stdout)["valid"])

    def test_apply_refuses_wrong_tree(self):
        r = run_cli("diff", self.old_path, self.new_path,
                    "-o", self.patch_path)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = run_cli("apply", self.new_path, self.patch_path)
        self.assertNotEqual(r.returncode, 0)

    def test_diff_to_stdout(self):
        r = run_cli("diff", self.old_path, self.new_path)
        self.assertEqual(r.returncode, 0, r.stderr)
        patch = json.loads(r.stdout)
        self.assertIn("certificate", patch)


if __name__ == "__main__":
    unittest.main()
