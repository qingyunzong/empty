import os
import random
import tempfile
import unittest

from deltaup import applier, encoder, reference
from deltaup.applier import Applier
from deltaup.errors import (
    ChecksumMismatchError,
    CopyBaseOutOfRangeError,
    CopyOutUngeneratedError,
    FormatError,
    LengthMismatchError,
    LengthOverflowError,
    UnexpectedEndError,
)

from helpers import apply_to_dir, build_stream, read_file, write_file


class RoundTripTest(unittest.TestCase):
    def test_encoder_roundtrip_large_window(self):
        rng = random.Random(1234)
        baseline = rng.randbytes(100_000)
        piece = rng.randbytes(80_000)
        target = (
            baseline[1000:60_000]
            + piece
            + piece  # forces a long COPY_OUT crossing the 64 KiB window
            + baseline[50_000:]
            + b"tail"
        )
        delta = encoder.encode_delta_bytes(baseline, target, block_size=1 << 16)
        with tempfile.TemporaryDirectory() as tmp:
            _result, target_path = apply_to_dir(delta, baseline, tmp)
            self.assertEqual(read_file(target_path), target)

    def test_encoder_roundtrip_tiny_window(self):
        rng = random.Random(99)
        baseline = rng.randbytes(20_000)
        target = baseline[500:9000] + rng.randbytes(300) + baseline[0:12_000]
        delta = encoder.encode_delta_bytes(baseline, target, block_size=4096)
        with tempfile.TemporaryDirectory() as tmp:
            _result, target_path = apply_to_dir(delta, baseline, tmp,
                                                window_size=64)
            self.assertEqual(read_file(target_path), target)

    def test_empty_target_and_baseline(self):
        delta = encoder.encode_delta_bytes(b"", b"")
        with tempfile.TemporaryDirectory() as tmp:
            _result, target_path = apply_to_dir(delta, b"", tmp)
            self.assertEqual(read_file(target_path), b"")


class ReferenceCrossCheckTest(unittest.TestCase):
    """Cross-check the windowed applier against the in-memory interpreter."""

    CASES = {
        "overlap_rle": [("add", b"a"), ("copy_out", 0, 999)],
        "overlap_pattern": [("add", b"abc"), ("copy_out", 0, 100)],
        "cross_window": [
            ("add", b"head"),
            ("copy_base", 0, 5000),
            ("copy_out", 0, 3000),
        ],
        "nested_reuse": [
            ("copy_base", 10, 100),
            ("copy_out", 0, 100),
            ("copy_out", 50, 300),
            ("copy_out", 0, 500),
        ],
        "zero_length_ops": [
            ("add", b""),
            ("copy_out", 0, 0),
            ("copy_base", 0, 0),
            ("add", b"x"),
        ],
    }

    def test_applier_matches_reference(self):
        baseline = bytes((i * 7) % 256 for i in range(6000))
        for name, instrs in self.CASES.items():
            with self.subTest(case=name):
                expected = reference.interpret(baseline, instrs)
                stream, target = build_stream(baseline, instrs, block_size=512)
                self.assertEqual(target, expected)
                with tempfile.TemporaryDirectory() as tmp:
                    _r, target_path = apply_to_dir(
                        stream, baseline, tmp, window_size=64
                    )
                    self.assertEqual(read_file(target_path), expected)


class ApplyErrorTest(unittest.TestCase):
    def setUp(self):
        self.baseline = bytes(range(256)) * 4

    def run_bad(self, stream, preexisting=b"original-target"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with self.assertRaises(Exception) as ctx:
            apply_to_dir(stream, self.baseline, tmp.name,
                         preexisting=preexisting)
        target_path = os.path.join(tmp.name, "target.bin")
        self.assertEqual(read_file(target_path), preexisting)
        return ctx.exception

    def test_copy_out_ungenerated(self):
        stream, _t = None, None
        # handcraft: first instruction copies output that does not exist
        blocks = [[("copy_out", 0, 4)]]
        # build_stream would fail in reference; craft manually
        import hashlib
        from deltaup.decoder import MAGIC
        from deltaup.varint import encode as varint
        from deltaup.encoder import instructions_to_bytes

        body = instructions_to_bytes(blocks[0])
        stream = (
            MAGIC + varint(len(self.baseline))
            + hashlib.sha256(self.baseline).digest()
            + varint(1)
            + varint(4) + b"\x00" * 32 + varint(len(body)) + body
            + varint(4) + b"\x00" * 32
        )
        exc = self.run_bad(stream)
        self.assertIsInstance(exc, CopyOutUngeneratedError)

    def test_copy_base_out_of_range(self):
        import hashlib
        from deltaup.decoder import MAGIC
        from deltaup.varint import encode as varint
        from deltaup.encoder import instructions_to_bytes

        body = instructions_to_bytes([("copy_base", len(self.baseline) - 2, 10)])
        stream = (
            MAGIC + varint(len(self.baseline))
            + hashlib.sha256(self.baseline).digest()
            + varint(1)
            + varint(10) + b"\x00" * 32 + varint(len(body)) + body
            + varint(10) + b"\x00" * 32
        )
        exc = self.run_bad(stream)
        self.assertIsInstance(exc, CopyBaseOutOfRangeError)

    def test_length_overflow_block_declared_too_small(self):
        import hashlib
        from deltaup.decoder import MAGIC
        from deltaup.varint import encode as varint
        from deltaup.encoder import instructions_to_bytes

        body = instructions_to_bytes([("add", b"too long")])
        stream = (
            MAGIC + varint(len(self.baseline))
            + hashlib.sha256(self.baseline).digest()
            + varint(1)
            + varint(1)  # block declares 1 output byte, ADD produces 8
            + b"\x00" * 32 + varint(len(body)) + body
            + varint(1) + b"\x00" * 32
        )
        exc = self.run_bad(stream)
        self.assertIsInstance(exc, LengthOverflowError)

    def test_block_hash_mismatch(self):
        stream, _target = build_stream(
            self.baseline, [("add", b"hello"), ("copy_base", 0, 10)]
        )
        # corrupt one ADD payload byte: output then fails the block hash
        bad = bytearray(stream)
        pos = stream.index(b"hello")
        bad[pos] ^= 0xFF
        exc = self.run_bad(bytes(bad))
        self.assertIsInstance(exc, ChecksumMismatchError)

    def test_total_hash_mismatch(self):
        stream, _target = build_stream(self.baseline, [("add", b"hello")])
        bad = bytearray(stream)
        bad[-1] ^= 0xFF  # last byte of the total hash
        exc = self.run_bad(bytes(bad))
        self.assertIsInstance(exc, ChecksumMismatchError)

    def test_truncated_stream(self):
        stream, _target = build_stream(self.baseline, [("add", b"hello")])
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        baseline_path = os.path.join(tmp.name, "baseline.bin")
        delta_path = os.path.join(tmp.name, "delta.bin")
        target_path = os.path.join(tmp.name, "target.bin")
        write_file(baseline_path, self.baseline)
        write_file(delta_path, stream[: len(stream) - 10])
        write_file(target_path, b"keep-me")
        ap = Applier(baseline_path, target_path)
        try:
            with open(delta_path, "rb") as fh:
                need = ap.feed(fh.read())
            self.assertGreater(need, 0)
            with self.assertRaises(UnexpectedEndError):
                ap.finish()
        finally:
            ap.close()
        self.assertEqual(read_file(target_path), b"keep-me")

    def test_bad_instruction_does_not_grow_output(self):
        # A failing COPY_OUT must leave the temp output at its prior length.
        import hashlib
        from deltaup.decoder import MAGIC
        from deltaup.varint import encode as varint
        from deltaup.encoder import instructions_to_bytes

        good = instructions_to_bytes([("add", b"abc")])
        bad = instructions_to_bytes([("copy_out", 100, 5)])
        body = good + bad
        stream = (
            MAGIC + varint(len(self.baseline))
            + hashlib.sha256(self.baseline).digest()
            + varint(1)
            + varint(8) + b"\x00" * 32 + varint(len(body)) + body
            + varint(8) + b"\x00" * 32
        )
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        baseline_path = os.path.join(tmp.name, "baseline.bin")
        delta_path = os.path.join(tmp.name, "delta.bin")
        target_path = os.path.join(tmp.name, "target.bin")
        write_file(baseline_path, self.baseline)
        write_file(delta_path, stream)
        ap = Applier(baseline_path, target_path)
        try:
            with self.assertRaises(CopyOutUngeneratedError):
                with open(delta_path, "rb") as fh:
                    ap.feed(fh.read())
            self.assertEqual(ap.out_len, 3)  # only the valid ADD landed
        finally:
            ap.close()
        self.assertFalse(os.path.exists(target_path))


if __name__ == "__main__":
    unittest.main()
