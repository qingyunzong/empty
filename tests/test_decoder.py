import unittest

from deltaup.decoder import MAGIC, Decoder
from deltaup.errors import FormatError, LengthOverflowError
from deltaup.varint import encode as varint

from helpers import build_stream


def make_stream():
    baseline = bytes(range(64))
    instrs = [
        ("add", b"hello world"),
        ("copy_base", 4, 20),
        ("copy_out", 0, 11),
        ("add", b"!"),
    ]
    return build_stream(baseline, instrs, block_size=20)


def normalized_events(decoder):
    """Event list with consecutive add_data chunks merged.

    ADD payload chunking legitimately depends on feed boundaries, so
    comparisons coalesce the payload into a single logical event.
    """
    merged = []
    pending = bytearray()
    for _off, name, args, _state in decoder.events:
        if name == "add_data":
            pending += args[0]
            continue
        if pending:
            merged.append(("add_data", (bytes(pending),)))
            pending = bytearray()
        merged.append((name, args))
    if pending:
        merged.append(("add_data", (bytes(pending),)))
    return merged


class DecoderSplitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = bytes(range(64))
        cls.stream, cls.target = make_stream()

    def decode_one_shot(self):
        dec = Decoder()
        dec.feed(self.stream)
        self.assertTrue(dec.finished)
        return normalized_events(dec)

    def test_every_two_part_split_matches_one_shot(self):
        expected = self.decode_one_shot()
        for cut in range(len(self.stream) + 1):
            with self.subTest(cut=cut):
                dec = Decoder()
                need = dec.feed(self.stream[:cut])
                if cut < len(self.stream):
                    self.assertGreaterEqual(need, 1)
                dec.feed(self.stream[cut:])
                self.assertTrue(dec.finished)
                self.assertEqual(dec.needed(), 0)
                self.assertEqual(normalized_events(dec), expected)

    def test_byte_by_byte_feed(self):
        expected = self.decode_one_shot()
        dec = Decoder()
        for i in range(len(self.stream)):
            need = dec.feed(self.stream[i : i + 1])
            self.assertIsInstance(need, int)
        self.assertTrue(dec.finished)
        self.assertEqual(normalized_events(dec), expected)

    def test_needed_bytes_progress(self):
        dec = Decoder()
        self.assertEqual(dec.feed(b""), len(MAGIC))
        self.assertEqual(dec.feed(self.stream[:4]), len(MAGIC) - 4)
        dec.feed(self.stream[4:])
        self.assertEqual(dec.needed(), 0)

    def test_events_carry_stream_offsets(self):
        dec = Decoder()
        dec.feed(self.stream)
        offsets = [off for off, _name, _args, _state in dec.events]
        self.assertEqual(offsets, sorted(offsets))
        self.assertEqual(offsets[-1], len(self.stream))


class DecoderErrorTest(unittest.TestCase):
    def test_bad_magic(self):
        dec = Decoder()
        with self.assertRaises(FormatError):
            dec.feed(b"XXXXXXXx" + b"\x00" * 64)

    def test_unknown_opcode(self):
        body = b"\x7f"  # invalid opcode
        stream = (
            MAGIC
            + varint(0)
            + b"\x00" * 32
            + varint(1)  # block count
            + varint(0)  # block out len
            + b"\x00" * 32
            + varint(len(body))
            + body
        )
        dec = Decoder()
        with self.assertRaises(FormatError):
            dec.feed(stream)

    def test_noncanonical_varint_in_header(self):
        dec = Decoder()
        with self.assertRaises(LengthOverflowError):
            dec.feed(MAGIC + b"\x80\x00")

    def test_instruction_overruns_block(self):
        # block declares 1 instruction byte, ADD needs more.
        body = b"\x01\x05ab"  # ADD len 5 -> 7 bytes total
        stream = (
            MAGIC
            + varint(0)
            + b"\x00" * 32
            + varint(1)
            + varint(5)
            + b"\x00" * 32
            + varint(1)  # instr_len too small
            + body
        )
        dec = Decoder()
        with self.assertRaises(FormatError):
            dec.feed(stream)

    def test_trailing_bytes_rejected(self):
        stream, _ = make_stream()
        dec = Decoder()
        with self.assertRaises(FormatError):
            dec.feed(stream + b"\x00")


if __name__ == "__main__":
    unittest.main()
