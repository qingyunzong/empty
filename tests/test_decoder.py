import hashlib
import unittest

from deltaupd import varint
from deltaupd.builder import build_update
from deltaupd.decoder import MAGIC, Decoder
from deltaupd.errors import (BadMagicError, LengthOverflowError,
                             NonCanonicalVarintError, TrailingDataError,
                             UnknownOpcodeError)

BASELINE = (b"baseline contents: the rain in spain falls mainly on the plain"
            b" 0123456789" * 4)
BLOCKS = [
    [("copy_base", 0, 30), ("add", b"XYZ"), ("copy_out", 3, 9),
     ("copy_base", 60, 40)],
    [("add", b"ab"), ("copy_out", 2, 6), ("copy_out", 8, 16)],
    [],
]
STREAM = build_update(BASELINE, BLOCKS)


def feed_all(chunks):
    decoder = Decoder()
    events = []
    needed = None
    for chunk in chunks:
        result = decoder.feed(chunk)
        events.extend(result.events)
        needed = result.needed
    return decoder, events, needed


def normalize(events):
    """Merge runs of add_data events (chunking depends on arrival pattern)."""
    merged = []
    for offset, event in events:
        if event[0] == "add_data" and merged and merged[-1][1][0] == "add_data":
            prev_offset, prev = merged[-1]
            merged[-1] = (offset, ("add_data", prev[1] + event[1]))
        else:
            merged.append((offset, event))
    return merged


class DecoderTest(unittest.TestCase):
    def test_one_shot_events(self):
        decoder, events, needed = feed_all([STREAM])
        kinds = [event[1][0] for event in events]
        self.assertEqual(kinds, ["header", "block_header",
                                 "copy_base", "add_begin", "add_data", "add_end",
                                 "copy_out", "copy_base", "end_block",
                                 "block_header", "add_begin", "add_data",
                                 "add_end", "copy_out", "copy_out", "end_block",
                                 "block_header", "end_block", "final_hash"])
        self.assertTrue(decoder.done)
        self.assertEqual(needed, 0)
        header = events[0][1]
        self.assertEqual(header[1], hashlib.sha256(BASELINE).digest())
        self.assertEqual(header[2], 3)
        # Event offsets are verified instruction boundaries: strictly
        # increasing and ending exactly at the stream length.
        offsets = [event[0] for event in events]
        self.assertEqual(offsets, sorted(offsets))
        self.assertEqual(offsets[-1], len(STREAM))

    def test_every_two_way_split(self):
        _, expected, _ = feed_all([STREAM])
        expected = normalize(expected)
        for cut in range(len(STREAM) + 1):
            with self.subTest(cut=cut):
                decoder, events, _ = feed_all([STREAM[:cut], STREAM[cut:]])
                self.assertTrue(decoder.done)
                self.assertEqual(normalize(events), expected)

    def test_byte_by_byte(self):
        decoder, events, _ = feed_all([bytes([b]) for b in STREAM])
        self.assertTrue(decoder.done)
        self.assertEqual(normalize(events), normalize(feed_all([STREAM])[1]))

    def test_needed_bytes_reported_for_every_prefix(self):
        for cut in range(len(STREAM)):
            with self.subTest(cut=cut):
                decoder = Decoder()
                result = decoder.feed(STREAM[:cut])
                self.assertFalse(decoder.done)
                self.assertGreaterEqual(result.needed, 1)
                # Feeding the remainder must complete the stream.
                result2 = decoder.feed(STREAM[cut:])
                self.assertTrue(decoder.done)
                self.assertEqual(result2.needed, 0)

    def test_needed_is_exact_for_fixed_fields(self):
        decoder = Decoder()
        result = decoder.feed(STREAM[:3])  # 3 of 6 magic bytes
        self.assertEqual(result.needed, 3)
        decoder = Decoder()
        result = decoder.feed(STREAM[:10])  # 4 of 32 fingerprint bytes
        self.assertEqual(result.needed, 28)

    def test_bad_magic(self):
        decoder = Decoder()
        with self.assertRaises(BadMagicError):
            decoder.feed(b"XXXXXX" + STREAM[6:])

    def test_unknown_opcode(self):
        stream = bytearray(STREAM)
        # First opcode byte sits right after magic+fingerprint+num_blocks
        # +block_len+block_hash.
        pos = 6 + 32 + 1 + 1 + 32
        stream[pos] = 0x7F
        decoder = Decoder()
        with self.assertRaises(UnknownOpcodeError):
            decoder.feed(bytes(stream))

    def test_non_canonical_varint(self):
        stream = MAGIC + bytes(32) + b"\x81\x80\x00"  # num_blocks non-canonical
        decoder = Decoder()
        with self.assertRaises(NonCanonicalVarintError):
            decoder.feed(stream)

    def test_length_overflow_varint(self):
        stream = MAGIC + bytes(32) + b"\xff" * 9 + b"\x7f"
        decoder = Decoder()
        with self.assertRaises(LengthOverflowError):
            decoder.feed(stream)

    def test_trailing_data_rejected(self):
        decoder = Decoder()
        with self.assertRaises(TrailingDataError):
            decoder.feed(STREAM + b"\x00")

    def test_resume_phases(self):
        # A decoder resumed at each boundary must finish like a fresh one.
        _, events, _ = feed_all([STREAM])
        num_blocks = 3
        seen = 0
        cases = []
        for offset, event in events:
            kind = event[0]
            if kind == "header":
                cases.append((offset, "block_header", 0))
            elif kind == "block_header":
                cases.append((offset, "instructions", seen))
            elif kind == "end_block":
                seen += 1
                phase = "block_header" if seen < num_blocks else "final"
                cases.append((offset, phase, seen))
        for offset, phase, blocks_seen in cases:
            with self.subTest(offset=offset, phase=phase):
                decoder = Decoder(phase=phase, blocks_seen=blocks_seen,
                                  num_blocks=num_blocks, consumed=offset)
                decoder.feed(STREAM[offset:])
                self.assertTrue(decoder.done)


if __name__ == "__main__":
    unittest.main()
