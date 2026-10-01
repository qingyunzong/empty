import json
import subprocess
import sys
import unittest


def run_cli(payload, command="build"):
    proc = subprocess.run(
        [sys.executable, "-m", "arrangement", command],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    return proc


class TestCli(unittest.TestCase):
    def test_build_and_verify(self):
        payload = {
            "segments": [
                [[0, 0], [4, 0]], [[4, 0], [4, 4]], [[4, 4], [0, 4]],
                [[0, 4], [0, 0]], [[0, 0], [4, 4]], [[2, -1], [2, 5]],
            ]
        }
        proc = run_cli(payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["verification"]["ok"])
        self.assertEqual(out["arrangement"]["euler"], 2)
        self.assertIn([2, 2], out["arrangement"]["intersections"])
        outer = [f for f in out["arrangement"]["faces"] if f["outer"]]
        self.assertEqual(len(outer), 1)

    def test_verify_command(self):
        proc = run_cli({"segments": [[[0, 0], [1, 0]], [[0, 1], [1, 1]]]},
                       command="verify")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["verification"]["ok"])

    def test_ops_insert_delete(self):
        payload = {
            "segments": [
                [[0, 0], [4, 0]], [[4, 0], [4, 2]], [[4, 2], [0, 2]],
                [[0, 2], [0, 0]], [[2, 0], [2, 2]],
            ],
            "ops": [{"delete": [5]}, {"insert": [[[0, 1], [4, 1]]]}],
        }
        proc = run_cli(payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["verification"]["ok"])
        self.assertEqual(len(out["affected"]), 2)

    def test_roundtrip_command(self):
        payload = {"segments": [[[0, 0], [3, 0]], [[1, -1], [1, 2]],
                                [["1/2", 0], ["1/2", 1]]]}
        proc = run_cli(payload, command="roundtrip")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["roundtrip"]["ok"])
        self.assertTrue(out["roundtrip"]["verification"]["ok"])

    def test_invalid_input_reports_error(self):
        proc = run_cli({"segments": [[["a", 0], [1, 1]]]})
        self.assertEqual(proc.returncode, 1)
        out = json.loads(proc.stdout)
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
