import unittest

from deltaupd import varint
from deltaupd.builder import build_update
from deltaupd.decoder import MAGIC
from deltaupd.errors import (BaselineRangeError, BlockLengthExceededError,
                             BlockLengthMismatchError, CopyOutOfRangeError,
                             FingerprintMismatchError, HashMismatchError,
                             UnknownOpcodeError)
from deltaupd.interpreter import interpret

BASELINE = bytes(range(256)) * 2


class InterpreterSemanticsTest(unittest.TestCase):
    def test_add_only(self):
        stream = build_update(b"", [[("add", b"hello world")]])
        self.assertEqual(interpret(b"", stream), b"hello world")

    def test_copy_base(self):
        stream = build_update(BASELINE, [[("copy_base", 10, 20)],
                                         [("copy_base", 300, 100)]])
        self.assertEqual(interpret(BASELINE, stream),
                         BASELINE[10:30] + BASELINE[300:400])

    def test_overlapping_copy_out_replicates_byte_by_byte(self):
        stream = build_update(b"", [[("add", b"a"), ("copy_out", 1, 9)]])
        self.assertEqual(interpret(b"", stream), b"a" * 10)

    def test_overlap_pattern(self):
        stream = build_update(b"", [[("add", b"abc"), ("copy_out", 3, 8)]])
        self.assertEqual(interpret(b"", stream), b"abc" + b"abcabcab")

    def test_nested_reuse(self):
        # Each COPY_OUT copies bytes that were themselves produced by a
        # previous COPY_OUT: ab -> abab -> abababab -> ...
        stream = build_update(b"", [[("add", b"ab"), ("copy_out", 2, 2),
                                     ("copy_out", 4, 4), ("copy_out", 8, 8),
                                     ("copy_out", 16, 16)]])
        self.assertEqual(interpret(b"", stream), b"ab" * 16)

    def test_empty_block_and_empty_output(self):
        stream = build_update(BASELINE, [[], [("add", b"x")], []])
        self.assertEqual(interpret(BASELINE, stream), b"x")
        stream = build_update(BASELINE, [])
        self.assertEqual(interpret(BASELINE, stream), b"")

    def test_copy_out_across_blocks(self):
        stream = build_update(BASELINE,
                              [[("add", b"0123456789")],
                               [("copy_out", 10, 10), ("copy_out", 5, 5)]])
        self.assertEqual(interpret(BASELINE, stream),
                         b"0123456789" * 2 + b"56789")


class InterpreterErrorTest(unittest.TestCase):
    def test_copy_out_of_ungenerated_region(self):
        with self.assertRaises(CopyOutOfRangeError):
            interpret(b"", _raw_stream(b"", [[(0x03, 5, 1)]], declared_len=1))

    def test_copy_base_out_of_range(self):
        with self.assertRaises(BaselineRangeError):
            interpret(b"abc", _raw_stream(b"abc", [[(0x02, 2, 5)]],
                                          declared_len=5))

    def test_instruction_exceeding_block_length(self):
        with self.assertRaises(BlockLengthExceededError):
            interpret(b"", _raw_stream(b"", [[(0x01, b"toolong")]],
                                       declared_len=3))

    def test_block_length_mismatch(self):
        with self.assertRaises(BlockLengthMismatchError):
            interpret(b"", _raw_stream(b"", [[(0x01, b"ab")]],
                                       declared_len=5))

    def test_fingerprint_mismatch(self):
        stream = build_update(BASELINE, [[("add", b"x")]])
        with self.assertRaises(FingerprintMismatchError):
            interpret(b"different baseline", stream)

    def test_bad_block_hash(self):
        stream = bytearray(build_update(b"", [[("add", b"data")]]))
        stream[40] ^= 0xFF  # inside first block hash
        with self.assertRaises(HashMismatchError):
            interpret(b"", bytes(stream))

    def test_bad_final_hash(self):
        stream = bytearray(build_update(b"", [[("add", b"data")]]))
        stream[-1] ^= 0xFF
        with self.assertRaises(HashMismatchError):
            interpret(b"", bytes(stream))

    def test_unknown_opcode(self):
        with self.assertRaises(UnknownOpcodeError):
            interpret(b"", _raw_stream(b"", [[(0x7F,)]]))


def _raw_stream(baseline, blocks, declared_len=None):
    """Hand-assemble a (possibly invalid) stream from raw instructions.

    Each instruction is a tuple (opcode, arg1, arg2); for ADD arg1 is the
    payload bytes.  Hashes/lengths are computed over what the instructions
    *would* produce, unless declared_len overrides the block length field.
    """
    import hashlib
    stream = bytearray(MAGIC)
    stream += hashlib.sha256(baseline).digest()
    stream += varint.encode(len(blocks))
    total = hashlib.sha256()
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
                for _ in range(ins[2]):
                    if ins[1] <= len(produced):
                        produced += produced[len(produced) - ins[1]:
                                             len(produced) - ins[1] + 1]
            else:
                body += bytes((op,))
        body += b"\x00"
        out_len = declared_len if declared_len is not None else len(produced)
        stream += varint.encode(out_len)
        stream += hashlib.sha256(bytes(produced)).digest()
        stream += body
        total.update(produced)
    stream += total.digest()
    return bytes(stream)


if __name__ == "__main__":
    unittest.main()
