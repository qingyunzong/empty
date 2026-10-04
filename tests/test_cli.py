import json
import os
import subprocess
import sys
import tempfile
import unittest


def run_cli(request):
    proc = subprocess.run(
        [sys.executable, "-m", "bareiss"],
        input=json.dumps(request), capture_output=True, text=True)
    return proc.returncode, json.loads(proc.stdout)


class TestCli(unittest.TestCase):
    def test_analyze_with_rhs_and_verification(self):
        code, out = run_cli({
            "command": "analyze",
            "matrix": [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]],
            "rhs": [[8, -11, -3]],
        })
        self.assertEqual(code, 0)
        self.assertEqual(out["rank"], 3)
        self.assertEqual(out["determinant"], -1)
        self.assertEqual(out["solutions"][0]["status"], "unique")
        self.assertEqual(out["solutions"][0]["particular"], [2, 3, -1])
        self.assertTrue(out["verification"][0]["particular_valid"])
        self.assertEqual(len(out["elimination_log"]), 3)

    def test_inconsistent_certificate_over_cli(self):
        code, out = run_cli({
            "command": "analyze",
            "matrix": [[1, 2], [2, 4]],
            "rhs": [[3, 7]],
        })
        self.assertEqual(code, 0)
        sol = out["solutions"][0]
        self.assertEqual(sol["status"], "inconsistent")
        y = sol["certificate"]
        self.assertTrue(out["verification"][0]["certificate_valid"])
        self.assertEqual(y[0] * 1 + y[1] * 2, 0)  # y^T A = 0
        self.assertNotEqual(y[0] * 3 + y[1] * 7, 0)  # y^T b != 0

    def test_update_via_checkpoint_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            cp1 = os.path.join(tmp, "a.json")
            cp2 = os.path.join(tmp, "b.json")
            code, out = run_cli({
                "command": "analyze",
                "matrix": [[1, 2], [2, 4]],
                "checkpoint_out": cp1,
            })
            self.assertEqual(code, 0)
            self.assertEqual(out["rank"], 1)
            self.assertTrue(os.path.exists(cp1))
            code, out = run_cli({
                "command": "update",
                "checkpoint_in": cp1,
                "add_rows": [[1, 1]],
                "rhs": [[1, 2, 1]],
                "checkpoint_out": cp2,
            })
            self.assertEqual(code, 0)
            self.assertEqual(out["rank"], 2)
            self.assertEqual(out["rows"], 3)
            self.assertEqual(out["solutions"][0]["status"], "unique")
            self.assertEqual(out["solutions"][0]["particular"], [1, 0])
            self.assertTrue(os.path.exists(cp2))
            # old checkpoint still queryable
            code, out = run_cli({
                "command": "update",
                "checkpoint_in": cp1,
                "replace_rows": {"1": [2, 5]},
            })
            self.assertEqual(code, 0)
            self.assertEqual(out["rank"], 2)
            self.assertEqual(out["determinant"], 1)

    def test_error_reported_as_json(self):
        code, out = run_cli({"command": "analyze",
                             "matrix": [[1, 2], [3]]})
        self.assertEqual(code, 1)
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
