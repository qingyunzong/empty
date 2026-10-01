import json
import os
import subprocess
import sys
import tempfile
import unittest


def run_cli(payload):
    env = dict(os.environ)
    proc = subprocess.run(
        [sys.executable, "-m", "arrangement.cli"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env=env,
    )
    return proc


class TestCli(unittest.TestCase):
    def test_build_verify_dump(self):
        proc = run_cli({"commands": [
            {"op": "build", "segments": [
                [[0, 0], [4, 0]], [[4, 0], [4, 4]],
                [[4, 4], [0, 4]], [[0, 4], [0, 0]],
                [[0, 0], [4, 4]],
            ]},
            {"op": "stats"},
            {"op": "verify"},
            {"op": "dump"},
        ]})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        results = json.loads(proc.stdout)
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(results[1]["stats"]["faces"], 3)
        checks = results[2]["checks"]
        self.assertTrue(checks["coverage"])
        self.assertTrue(checks["half_edges_paired"])
        self.assertTrue(checks["face_loops_closed"])
        self.assertTrue(checks["euler"])
        dump = results[3]
        self.assertEqual(len(dump["edges"]), 5)
        self.assertEqual(len(dump["faces"]), 3)

    def test_add_remove_and_rationals(self):
        proc = run_cli({"commands": [
            {"op": "add", "segments": [[[0, 0], [3, 1]], [[0, 1], [3, 0]]]},
            {"op": "dump"},
            {"op": "remove", "ids": [2]},
            {"op": "verify"},
        ]})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        results = json.loads(proc.stdout)
        self.assertEqual(results[0]["added"], [1, 2])
        xs = {v["x"] for v in results[1]["vertices"]}
        self.assertIn("3/2", xs)  # exact rational crossing point
        self.assertTrue(results[3]["ok"])

    def test_failed_command_does_not_corrupt(self):
        proc = run_cli({"commands": [
            {"op": "build", "segments": [[[0, 0], [4, 0]]]},
            {"op": "add", "segments": [[[0, 0], [1.5, 2]]]},
            {"op": "remove", "ids": [42]},
            {"op": "verify"},
            {"op": "stats"},
        ]})
        results = json.loads(proc.stdout)
        self.assertEqual(proc.returncode, 1)  # some commands failed
        self.assertFalse(results[1]["ok"])
        self.assertFalse(results[2]["ok"])
        self.assertTrue(results[3]["ok"])
        self.assertEqual(results[4]["stats"]["segments"], 1)

    def test_save_and_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "arr.json")
            proc = run_cli({"commands": [
                {"op": "build", "segments": [
                    [[0, 0], [4, 0]], [[4, 0], [4, 4]],
                    [[4, 4], [0, 4]], [[0, 4], [0, 0]],
                    [[0, 0], [4, 4]],
                ]},
                {"op": "save", "path": path},
            ]})
            self.assertEqual(proc.returncode, 0, proc.stderr)
            proc = run_cli({"commands": [
                {"op": "load", "path": path},
                {"op": "verify"},
                {"op": "add", "segments": [[[10, 10], [12, 10]]]},
                {"op": "dump"},
            ]})
            self.assertEqual(proc.returncode, 0, proc.stderr)
            results = json.loads(proc.stdout)
            self.assertTrue(results[1]["ok"])
            self.assertEqual(results[3]["stats"] if "stats" in results[3]
                             else results[0]["stats"]["edges"], 5)
            self.assertEqual(len(results[3]["edges"]), 6)

    def test_file_argument(self):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump([{"op": "add",
                        "segments": [[[0, 0], [1, 1]]]},
                       {"op": "stats"}], fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "arrangement.cli", path],
                capture_output=True, text=True,
                cwd=os.path.dirname(os.path.dirname(
                    os.path.abspath(__file__))),
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            results = json.loads(proc.stdout)
            self.assertEqual(results[1]["stats"]["edges"], 1)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
