import json
import os
import subprocess
import sys
import unittest

from helpers import WorkspaceTestCase

BASELINE = (b"line one\nline two\nline three\n" * 40
            + bytes(range(256)) * 4)
TARGET = (b"line one\nline TWO\nline three\n" * 40
          + b"brand new tail\n" + bytes(range(256)) * 4)


def run_cli(*args, cwd=None):
    return subprocess.run([sys.executable, "-m", "deltaupd", *args],
                          capture_output=True, text=True, cwd=cwd)


class CliTest(WorkspaceTestCase):
    def setUp(self):
        super().setUp()
        self.write("baseline.bin", BASELINE)
        self.write("wanted.bin", TARGET)

    def _encode(self, block_size=1 << 20):
        proc = run_cli("encode", "--baseline", self.path("baseline.bin"),
                       "--target", self.path("wanted.bin"),
                       "--output", self.path("update.bin"),
                       "--block-size", str(block_size))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def _apply(self, *extra):
        proc = run_cli("apply", "--baseline", self.path("baseline.bin"),
                       "--update", self.path("update.bin"),
                       "--target", self.path("target.bin"),
                       "--state-dir", self.make_state_dir(), *extra)
        return proc, json.loads(proc.stdout)

    def test_encode_apply_roundtrip(self):
        info = self._encode(block_size=200)
        self.assertEqual(info["status"], "encoded")
        proc, result = self._apply()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.read("target.bin"), TARGET)

    def test_apply_is_atomic_on_corrupt_update(self):
        self._encode()
        self.write("target.bin", b"original target")
        data = bytearray(self.read("update.bin"))
        data[-1] ^= 0xFF
        self.write("update.bin", bytes(data))
        proc, result = self._apply()
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error_type"], "HashMismatchError")
        self.assertEqual(self.read("target.bin"), b"original target")

    def test_interrupted_apply_resumes(self):
        self._encode()
        proc, result = self._apply("--max-events", "2")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(result["error_type"], "Interrupted")
        self.assertFalse(os.path.exists(self.path("target.bin")))
        proc, result = self._apply()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.read("target.bin"), TARGET)

    def test_tampered_baseline_rejected(self):
        self._encode()
        proc, result = self._apply("--max-events", "1")
        self.assertEqual(result["error_type"], "Interrupted")
        data = bytearray(self.read("baseline.bin"))
        data[5] ^= 0xFF
        self.write("baseline.bin", bytes(data))
        proc, result = self._apply()
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(result["error_type"], "FingerprintMismatchError")
        self.assertFalse(os.path.exists(self.path("target.bin")))

    def test_truncated_update_reports_need_more(self):
        self._encode()
        data = self.read("update.bin")
        self.write("update.bin", data[: len(data) // 2])
        proc, result = self._apply()
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(result["status"], "need_more")
        self.assertGreaterEqual(result["needed"], 1)
        self.write("update.bin", data)
        proc, result = self._apply()
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.read("target.bin"), TARGET)

    def test_wrong_baseline_stream_rejected(self):
        self._encode()
        self.write("baseline.bin", b"completely different baseline")
        proc, result = self._apply()
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(result["error_type"], "FingerprintMismatchError")


if __name__ == "__main__":
    unittest.main()
