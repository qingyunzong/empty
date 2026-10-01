import hashlib
import json
import os
import unittest

from deltaupd import varint
from deltaupd.applier import Applier
from deltaupd.builder import build_update
from deltaupd.decoder import MAGIC
from deltaupd.errors import (BadMagicError, BaselineRangeError,
                             BlockLengthExceededError,
                             BlockLengthMismatchError, CheckpointError,
                             CopyOutOfRangeError, FingerprintMismatchError,
                             HashMismatchError, Interrupted,
                             LengthOverflowError, NonCanonicalVarintError,
                             UnknownOpcodeError)
from deltaupd.interpreter import interpret

from helpers import WorkspaceTestCase

BASELINE = (b"The quick brown fox jumps over the lazy dog. " * 8
            + bytes(range(256)))

# A battery covering: plain adds, baseline copies, overlapping copies,
# nested reuse, copies reaching back across the memory window, copies
# spanning the window/temp-file boundary, and multi-block streams.
CASES = {
    "add_only": [[("add", b"hello world")]],
    "copy_base": [[("copy_base", 0, 50)], [("copy_base", 300, 120)]],
    "overlap_dist1": [[("add", b"a"), ("copy_out", 1, 39)]],
    "overlap_pattern": [[("add", b"abc"), ("copy_out", 3, 29)]],
    "nested_reuse": [[("add", b"xy"), ("copy_out", 2, 2), ("copy_out", 4, 4),
                      ("copy_out", 8, 8), ("copy_out", 16, 16),
                      ("copy_out", 32, 32)]],
    "cross_window": [[("add", b"0123456789" * 10), ("copy_out", 100, 60),
                      ("copy_out", 97, 30)]],
    "window_boundary_span": [[("add", b"z" * 7), ("copy_base", 0, 9),
                              ("copy_out", 13, 21)]],
    "mixed_blocks": [[("copy_base", 10, 25), ("add", b"MID"),
                      ("copy_out", 8, 16)],
                     [("copy_out", 44, 22), ("copy_base", 100, 30)],
                     [("add", b"end")]],
    "empty_blocks": [[], [("add", b"x")], []],
    "no_blocks": [],
    "large_add": [[("add", os.urandom(5000))]],
}


class ApplierCrossCheckTest(WorkspaceTestCase):
    """Windowed applier must agree with the independent in-memory oracle."""

    def _apply(self, baseline, stream, window_size, read_chunk_size=1 << 16):
        self.write("baseline.bin", baseline)
        self.write("update.bin", stream)
        state = self.make_state_dir()
        with Applier(self.path("baseline.bin"), self.path("update.bin"),
                     self.path("target.bin"), state,
                     window_size=window_size,
                     read_chunk_size=read_chunk_size) as applier:
            result = applier.run()
        self.assertEqual(result["status"], "applied")
        self.assertLessEqual(applier._sink.recent_size, window_size)
        return result

    def test_cases_match_oracle(self):
        for name, blocks in CASES.items():
            for window in (8, 64, 1 << 16):
                with self.subTest(case=name, window=window):
                    stream = build_update(BASELINE, blocks)
                    expected = interpret(BASELINE, stream)
                    result = self._apply(BASELINE, stream, window)
                    self.assertEqual(self.read("target.bin"), expected)
                    self.assertEqual(
                        result["sha256"], hashlib.sha256(expected).hexdigest())

    def test_window_never_exceeds_bound(self):
        stream = build_update(BASELINE, CASES["cross_window"])
        self.write("baseline.bin", BASELINE)
        self.write("update.bin", stream)
        state = self.make_state_dir()
        peaks = []
        with Applier(self.path("baseline.bin"), self.path("update.bin"),
                     self.path("target.bin"), state, window_size=16) as applier:
            sink = applier._sink
            original_write = sink.write

            def spy(data):
                original_write(data)
                peaks.append(sink.recent_size)

            sink.write = spy
            applier.run()
        self.assertTrue(peaks)
        self.assertLessEqual(max(peaks), 16)

    def test_arbitrary_input_chunking(self):
        stream = build_update(BASELINE, CASES["mixed_blocks"])
        expected = interpret(BASELINE, stream)
        for chunk_size in (1, 2, 3, 7, 64, len(stream)):
            with self.subTest(chunk_size=chunk_size):
                result = self._apply(BASELINE, stream, 32,
                                     read_chunk_size=chunk_size)
                self.assertEqual(self.read("target.bin"), expected)


class ApplierResumeTest(WorkspaceTestCase):
    def setUp(self):
        super().setUp()
        self.stream = build_update(BASELINE, CASES["mixed_blocks"])
        self.expected = interpret(BASELINE, self.stream)
        self.write("baseline.bin", BASELINE)
        self.write("update.bin", self.stream)

    def _run_once(self, interrupt_after=None, chunk=5, window=16):
        with Applier(self.path("baseline.bin"), self.path("update.bin"),
                     self.path("target.bin"), self.make_state_dir(),
                     window_size=window, interrupt_after=interrupt_after,
                     read_chunk_size=chunk) as applier:
            return applier.run(), applier._boundaries

    def _boundary_count(self):
        state = self.make_state_dir("count-state")
        with Applier(self.path("baseline.bin"), self.path("update.bin"),
                     self.path("count-target.bin"), state,
                     window_size=16) as applier:
            applier.run()
            return applier._boundaries

    def test_every_interruption_point_resumes_to_one_shot_result(self):
        total = self._boundary_count()
        for k in range(1, total + 1):
            with self.subTest(interrupt_after=k):
                try:
                    self._run_once(interrupt_after=k)
                    self.fail("expected Interrupted")
                except Interrupted:
                    pass
                result, _ = self._run_once()
                self.assertEqual(result["status"], "applied")
                self.assertEqual(self.read("target.bin"), self.expected)

    def test_chained_interruption_at_every_boundary(self):
        interrupts = 0
        while True:
            try:
                result, _ = self._run_once(interrupt_after=1)
                break
            except Interrupted:
                interrupts += 1
        self.assertGreater(interrupts, 0)
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.read("target.bin"), self.expected)

    def test_incomplete_stream_reports_need_more_then_resumes(self):
        cut = len(self.stream) - 40
        self.write("partial.bin", self.stream[:cut])
        state = self.make_state_dir()
        with Applier(self.path("baseline.bin"), self.path("partial.bin"),
                     self.path("target.bin"), state, window_size=16) as applier:
            result = applier.run()
        self.assertEqual(result["status"], "need_more")
        self.assertGreaterEqual(result["needed"], 1)
        self.assertFalse(os.path.exists(self.path("target.bin")))
        # The rest of the stream arrives; resume finishes the update.
        self.write("partial.bin", self.stream)
        with Applier(self.path("baseline.bin"), self.path("partial.bin"),
                     self.path("target.bin"), state, window_size=16) as applier:
            result = applier.run()
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.read("target.bin"), self.expected)

    def test_tampered_baseline_rejected(self):
        with self.assertRaises(Interrupted):
            self._run_once(interrupt_after=2)
        data = bytearray(self.read("baseline.bin"))
        data[0] ^= 0xFF
        self.write("baseline.bin", bytes(data))
        with self.assertRaises(FingerprintMismatchError):
            self._run_once()

    def test_tampered_temp_output_rejected(self):
        with self.assertRaises(Interrupted):
            self._run_once(interrupt_after=3)
        temp = self.path("state/output.tmp")
        with open(temp, "r+b") as fh:
            fh.seek(1)
            byte = fh.read(1)
            fh.seek(1)
            fh.write(bytes((byte[0] ^ 0xFF,)))
        with self.assertRaises(CheckpointError):
            self._run_once()

    def test_truncated_temp_output_rejected(self):
        with self.assertRaises(Interrupted):
            self._run_once(interrupt_after=3)
        temp = self.path("state/output.tmp")
        with open(temp, "r+b") as fh:
            fh.truncate(2)
        with self.assertRaises(CheckpointError):
            self._run_once()

    def test_missing_temp_output_rejected(self):
        with self.assertRaises(Interrupted):
            self._run_once(interrupt_after=3)
        os.unlink(self.path("state/output.tmp"))
        with self.assertRaises(CheckpointError):
            self._run_once()


class ApplierFailureTest(WorkspaceTestCase):
    """Failures must never modify an existing target file."""

    ORIGINAL = b"previous good target content"

    def setUp(self):
        super().setUp()
        self.write("baseline.bin", BASELINE)
        self.write("target.bin", self.ORIGINAL)

    def _apply_stream(self, stream):
        self.write("update.bin", stream)
        with Applier(self.path("baseline.bin"), self.path("update.bin"),
                     self.path("target.bin"), self.make_state_dir(),
                     window_size=16, read_chunk_size=4) as applier:
            return applier.run()

    def _assert_target_untouched(self):
        self.assertEqual(self.read("target.bin"), self.ORIGINAL)

    def test_bad_final_hash(self):
        stream = bytearray(build_update(BASELINE, [[("add", b"data")]]))
        stream[-1] ^= 0xFF
        with self.assertRaises(HashMismatchError):
            self._apply_stream(bytes(stream))
        self._assert_target_untouched()

    def test_bad_block_hash(self):
        stream = bytearray(build_update(BASELINE, [[("add", b"data")]]))
        stream[40] ^= 0xFF
        with self.assertRaises(HashMismatchError):
            self._apply_stream(bytes(stream))
        self._assert_target_untouched()

    def test_bad_magic(self):
        stream = b"XXXXXX" + build_update(BASELINE, [[("add", b"x")]])[6:]
        with self.assertRaises(BadMagicError):
            self._apply_stream(stream)
        self._assert_target_untouched()

    def test_unknown_opcode(self):
        stream = bytearray(build_update(BASELINE, [[("add", b"data")]]))
        stream[72] = 0x7F  # first opcode position
        with self.assertRaises(UnknownOpcodeError):
            self._apply_stream(bytes(stream))
        self._assert_target_untouched()

    def test_length_overflow_varint(self):
        stream = MAGIC + hashlib.sha256(BASELINE).digest() + b"\xff" * 10
        with self.assertRaises(LengthOverflowError):
            self._apply_stream(stream)
        self._assert_target_untouched()

    def test_non_canonical_varint(self):
        stream = (MAGIC + hashlib.sha256(BASELINE).digest()
                  + b"\x81\x80\x00")  # num_blocks non-canonical
        with self.assertRaises(NonCanonicalVarintError):
            self._apply_stream(stream)
        self._assert_target_untouched()

    def test_copy_out_of_ungenerated_region(self):
        stream = _crafted(BASELINE, [[(0x03, 10, 4)]], declared_len=4)
        with self.assertRaises(CopyOutOfRangeError):
            self._apply_stream(stream)
        self._assert_target_untouched()

    def test_copy_base_out_of_range(self):
        stream = _crafted(BASELINE, [[(0x02, len(BASELINE) - 2, 10)]],
                          declared_len=10)
        with self.assertRaises(BaselineRangeError):
            self._apply_stream(stream)
        self._assert_target_untouched()

    def test_block_length_mismatch(self):
        stream = _crafted(BASELINE, [[(0x01, b"ab")]], declared_len=9)
        with self.assertRaises(BlockLengthMismatchError):
            self._apply_stream(stream)
        self._assert_target_untouched()

    def test_anomalous_instruction_does_not_grow_output(self):
        # ADD of 8 bytes with only 3 bytes left in the declared block
        # length: must be rejected before a single byte of it is written.
        stream = _crafted(BASELINE, [[(0x01, b"hi"), (0x01, b"12345678")]],
                          declared_len=5)
        self.write("update.bin", stream)
        state = self.make_state_dir()
        with Applier(self.path("baseline.bin"), self.path("update.bin"),
                     self.path("target.bin"), state, window_size=16,
                     read_chunk_size=4) as applier:
            with self.assertRaises(BlockLengthExceededError):
                applier.run()
            self.assertEqual(applier._sink.length, 2)  # only the first ADD
        self._assert_target_untouched()

    def test_error_types_are_distinct(self):
        # Length overflow and copy-of-ungenerated-region are different,
        # precisely-typed failures.
        self.assertNotEqual(LengthOverflowError, CopyOutOfRangeError)
        overflow = MAGIC + hashlib.sha256(BASELINE).digest() + b"\xff" * 10
        with self.assertRaises(LengthOverflowError):
            self._apply_stream(overflow)
        with self.assertRaises(CopyOutOfRangeError):
            self._apply_stream(_crafted(BASELINE, [[(0x03, 10, 4)]],
                                        declared_len=4))
        self._assert_target_untouched()


def _crafted(baseline, blocks, declared_len=None):
    """Assemble a stream whose declared hashes match what the (possibly
    invalid) instructions would produce, so semantic checks are exercised."""
    stream = bytearray(MAGIC)
    stream += hashlib.sha256(baseline).digest()
    stream += varint.encode(len(blocks))
    total = hashlib.sha256()
    produced_all = bytearray()
    for block in blocks:
        body = bytearray()
        produced = bytearray()
        for ins in block:
            op = ins[0]
            if op == 0x01:
                data = ins[1]
                body += b"\x01" + varint.encode(len(data)) + data
                produced += data
            elif op == 0x02:
                body += b"\x02" + varint.encode(ins[1]) + varint.encode(ins[2])
                produced += baseline[ins[1]:ins[1] + ins[2]]
            elif op == 0x03:
                body += b"\x03" + varint.encode(ins[1]) + varint.encode(ins[2])
                available = produced_all + produced
                for _ in range(ins[2]):
                    if ins[1] <= len(available):
                        produced += available[len(available) - ins[1]:
                                              len(available) - ins[1] + 1]
                        available = produced_all + produced
            else:
                body += bytes((op,))
        body += b"\x00"
        out_len = declared_len if declared_len is not None else len(produced)
        stream += varint.encode(out_len)
        stream += hashlib.sha256(bytes(produced)).digest()
        stream += body
        total.update(produced)
        produced_all += produced
    stream += total.digest()
    return bytes(stream)


if __name__ == "__main__":
    unittest.main()
