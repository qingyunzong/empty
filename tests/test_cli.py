import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from helpers import read_file, write_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "deltaup", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        rng = random.Random(7)
        self.baseline = rng.randbytes(30_000)
        self.target = (
            self.baseline[100:9000]
            + b"new-data" * 500
            + self.baseline[20_000:]
            + self.baseline[100:9000]
        )
        self.baseline_path = os.path.join(self.tmp.name, "base.bin")
        self.target_path = os.path.join(self.tmp.name, "target.bin")
        self.delta_path = os.path.join(self.tmp.name, "out.dupd")
        write_file(self.baseline_path, self.baseline)
        write_file(self.target_path, self.target)

    def test_encode_apply_roundtrip(self):
        proc = run_cli(
            "encode", "--baseline", self.baseline_path,
            "--target", self.target_path, "--out", self.delta_path,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertTrue(report["ok"])
        self.assertGreater(report["delta_bytes"], 0)

        os.unlink(self.target_path)
        proc = run_cli(
            "apply", "--baseline", self.baseline_path,
            "--delta", self.delta_path, "--target", self.target_path,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["bytes_written"], len(self.target))
        self.assertEqual(read_file(self.target_path), self.target)

    def test_apply_corrupt_delta_reports_json_error(self):
        proc = run_cli(
            "encode", "--baseline", self.baseline_path,
            "--target", self.target_path, "--out", self.delta_path,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = bytearray(read_file(self.delta_path))
        data[-1] ^= 0xFF
        write_file(self.delta_path, bytes(data))
        proc = run_cli(
            "apply", "--baseline", self.baseline_path,
            "--delta", self.delta_path, "--target", self.target_path,
        )
        self.assertEqual(proc.returncode, 1)
        report = json.loads(proc.stdout)
        self.assertFalse(report["ok"])
        self.assertEqual(report["error_type"], "ChecksumMismatchError")
        self.assertEqual(read_file(self.target_path), self.target)

    def test_cli_resume(self):
        proc = run_cli(
            "encode", "--baseline", self.baseline_path,
            "--target", self.target_path, "--out", self.delta_path,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

        # Simulate an interrupted apply: run apply with a delta truncated
        # after the header, leaving a checkpoint behind via the library.
        from deltaup import applier
        from deltaup.applier import EventLimitReached

        os.unlink(self.target_path)
        with self.assertRaises(EventLimitReached):
            applier.apply_delta(
                self.baseline_path, self.delta_path, self.target_path,
                event_limit=2,
            )
        checkpoint = os.path.join(self.tmp.name, ".target.bin.ckpt")
        proc = run_cli(
            "resume", "--baseline", self.baseline_path,
            "--delta", self.delta_path, "--target", self.target_path,
            "--checkpoint", checkpoint,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(read_file(self.target_path), self.target)


if __name__ == "__main__":
    unittest.main()
