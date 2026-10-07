import json
import subprocess
import sys
import tempfile
import unittest

PY = sys.executable


class TestCli(unittest.TestCase):
    def run_cli(self, lines, use_dir=None):
        args = [PY, "-m", "mvview"]
        if use_dir:
            args += ["--dir", use_dir]
        proc = subprocess.run(
            args, input="\n".join(json.dumps(x) for x in lines),
            capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return [json.loads(x) for x in proc.stdout.splitlines()]

    def test_batch_view_median_rank(self):
        out = self.run_cli([
            {"cmd": "batch", "left_insert": [{"id": 1, "cid": "a", "value": 2},
                                             {"id": 2, "cid": "a", "value": 5}],
             "right_insert": [{"cid": "a", "group": "g"}]},
            {"cmd": "view"},
            {"cmd": "median", "group": "g"},
            {"cmd": "rank", "group": "g", "value": 5},
            {"cmd": "batch", "left_insert": [{"id": 1, "cid": "a"}]},  # dup id
        ])
        self.assertTrue(out[0]["ok"])
        self.assertEqual(out[1]["view"], {"g": {"count": 2, "sum": 7, "median": "7/2"}})
        self.assertEqual(out[2]["median"], "7/2")
        self.assertEqual(out[3]["rank"], 1)
        self.assertFalse(out[4]["ok"])
        self.assertIn("unique id conflict", out[4]["error"])

    def test_checkpoint_and_recover_via_cli(self):
        with tempfile.TemporaryDirectory() as d:
            out = self.run_cli([
                {"cmd": "batch", "left_insert": [{"id": 1, "cid": "a", "value": 4}],
                 "right_insert": [{"cid": "a", "group": "g"}]},
                {"cmd": "checkpoint"},
            ], use_dir=d)
            self.assertTrue(out[1]["ok"])
            # new process recovers from the log + checkpoint
            out2 = self.run_cli([{"cmd": "view"}], use_dir=d)
            self.assertEqual(out2[0]["view"], {"g": {"count": 1, "sum": 4, "median": 4}})


if __name__ == "__main__":
    unittest.main()
