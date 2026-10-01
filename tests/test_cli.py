import contextlib
import io
import os
import random
import tempfile
import unittest

from rchunk.cli import main
from rchunk import loads, locate


def run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        rng = random.Random(31337)
        self.data = rng.randbytes(120_000)
        self.data_path = os.path.join(self.tmp.name, "data.bin")
        with open(self.data_path, "wb") as fh:
            fh.write(self.data)
        self.index_path = os.path.join(self.tmp.name, "data.bin.chunk")

    def chunk(self, *extra):
        code, _, _ = run_cli(["chunk", self.data_path, "-o", self.index_path, *extra])
        self.assertEqual(code, 0)

    def test_chunk_and_verify_roundtrip(self):
        self.chunk()
        code, out, _ = run_cli(["verify", self.data_path, self.index_path])
        self.assertEqual(code, 0)
        self.assertIn("OK", out)

    def test_chunk_default_output_name(self):
        code, out, _ = run_cli(["chunk", self.data_path])
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(self.index_path))

    def test_buffer_size_flag_does_not_change_index(self):
        self.chunk("--buffer-size", "8")
        with open(self.index_path, "rb") as fh:
            small = fh.read()
        self.chunk("--buffer-size", "65536")
        with open(self.index_path, "rb") as fh:
            large = fh.read()
        self.assertEqual(small, large)

    def test_verify_detects_single_byte_flip(self):
        self.chunk()
        pos = 50_000
        with open(self.data_path, "r+b") as fh:
            fh.seek(pos)
            fh.write(bytes([self.data[pos] ^ 0xFF]))
        code, _, err = run_cli(["verify", self.data_path, self.index_path])
        self.assertEqual(code, 1)
        self.assertIn("CORRUPT", err)
        with open(self.index_path, "rb") as fh:
            entries = loads(fh.read())
        expected = locate(entries, pos)
        self.assertIn(f"offset {expected.offset}", err)

    def test_locate_command(self):
        self.chunk()
        pos = 70_000
        code, out, _ = run_cli(["locate", self.index_path, str(pos)])
        self.assertEqual(code, 0)
        with open(self.index_path, "rb") as fh:
            entries = loads(fh.read())
        entry = locate(entries, pos)
        self.assertIn(f"offset={entry.offset}", out)
        self.assertIn(f"len={entry.length}", out)

    def test_locate_out_of_range(self):
        self.chunk()
        code, _, err = run_cli(["locate", self.index_path, str(len(self.data))])
        self.assertEqual(code, 1)
        self.assertIn("CORRUPT", err)

    def test_verify_corrupt_index_file(self):
        with open(self.index_path, "wb") as fh:
            fh.write(b"RCHUNK1\n0 10 " + b"0" * 64 + b"\n7 10 " + b"0" * 64 + b"\n")
        code, _, err = run_cli(["verify", self.data_path, self.index_path])
        self.assertEqual(code, 1)
        self.assertIn("CORRUPT", err)


if __name__ == "__main__":
    unittest.main()
