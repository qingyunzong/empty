import hashlib
import random
import unittest

from rchunk import (
    ChunkEntry,
    CorruptError,
    chunk_stream,
    dumps,
    entries_from_data,
    loads,
    locate,
    verify,
)


def make_entries(data, buffer_size=65536):
    return entries_from_data(data, chunk_stream(data, buffer_size))


class TestIndexFormat(unittest.TestCase):
    def setUp(self):
        rng = random.Random(99)
        self.data = rng.randbytes(50_000)
        self.entries = make_entries(self.data)

    def test_roundtrip(self):
        raw = dumps(self.entries)
        self.assertEqual(loads(raw), self.entries)
        self.assertTrue(raw.startswith(b"RCHUNK1\n"))

    def test_empty_index_roundtrip(self):
        raw = dumps([])
        self.assertEqual(loads(raw), [])
        verify([], b"")

    def test_gap_is_corrupt(self):
        bad = [
            ChunkEntry(0, 100, b"\x00" * 32),
            ChunkEntry(101, 100, b"\x00" * 32),
        ]
        with self.assertRaises(CorruptError):
            dumps(bad)
        raw = b"RCHUNK1\n0 100 " + b"0" * 64 + b"\n101 100 " + b"0" * 64 + b"\n"
        with self.assertRaises(CorruptError):
            loads(raw)

    def test_overlap_is_corrupt(self):
        bad = [
            ChunkEntry(0, 100, b"\x00" * 32),
            ChunkEntry(50, 100, b"\x00" * 32),
        ]
        with self.assertRaises(CorruptError):
            dumps(bad)

    def test_unsorted_is_corrupt(self):
        bad = [
            ChunkEntry(100, 100, b"\x00" * 32),
            ChunkEntry(0, 100, b"\x00" * 32),
        ]
        with self.assertRaises(CorruptError):
            dumps(bad)

    def test_bad_header(self):
        with self.assertRaises(CorruptError):
            loads(b"RCHUNK0\n")

    def test_bad_digest_field(self):
        with self.assertRaises(CorruptError):
            loads(b"RCHUNK1\n0 10 " + b"z" * 64 + b"\n")
        with self.assertRaises(CorruptError):
            loads(b"RCHUNK1\n0 10 " + b"0" * 63 + b"\n")

    def test_nonpositive_length(self):
        with self.assertRaises(CorruptError):
            loads(b"RCHUNK1\n0 0 " + b"0" * 64 + b"\n")


class TestVerify(unittest.TestCase):
    def setUp(self):
        rng = random.Random(1234)
        self.data = bytearray(rng.randbytes(80_000))
        self.entries = make_entries(bytes(self.data))

    def test_verify_ok(self):
        verify(self.entries, bytes(self.data))

    def test_single_byte_flip_reports_covering_chunk(self):
        pos = 40_000
        self.data[pos] ^= 0xFF
        with self.assertRaises(CorruptError) as ctx:
            verify(self.entries, bytes(self.data))
        expected = locate(self.entries, pos)
        self.assertEqual(ctx.exception.offset, expected.offset)

    def test_first_bad_chunk_reports_minimal_offset(self):
        positions = [70_000, 10_000]
        for pos in positions:
            self.data[pos] ^= 0xFF
        with self.assertRaises(CorruptError) as ctx:
            verify(self.entries, bytes(self.data))
        earlier = locate(self.entries, 10_000)
        later = locate(self.entries, 70_000)
        self.assertLess(earlier.offset, later.offset)
        self.assertEqual(ctx.exception.offset, earlier.offset)

    def test_trailing_data_is_corrupt(self):
        with self.assertRaises(CorruptError):
            verify(self.entries, bytes(self.data) + b"x")

    def test_truncated_data_is_corrupt(self):
        with self.assertRaises(CorruptError):
            verify(self.entries, bytes(self.data[:-1]))


class TestLocate(unittest.TestCase):
    def setUp(self):
        rng = random.Random(555)
        self.data = rng.randbytes(60_000)
        self.entries = make_entries(self.data)

    def test_locate_covers_position(self):
        for pos in (0, 1, 63, 64, 4095, 4096, 30_000, len(self.data) - 1):
            entry = locate(self.entries, pos)
            self.assertLessEqual(entry.offset, pos)
            self.assertLess(pos, entry.offset + entry.length)

    def test_locate_returns_chunk_at_boundary(self):
        second = self.entries[1]
        self.assertEqual(locate(self.entries, second.offset), second)
        self.assertEqual(locate(self.entries, second.offset - 1), self.entries[0])

    def test_locate_is_minimal_covering_chunk(self):
        # after flipping a byte, locate finds exactly the chunk verify blames
        pos = 12_345
        entry = locate(self.entries, pos)
        mutated = bytearray(self.data)
        mutated[pos] ^= 0x01
        with self.assertRaises(CorruptError) as ctx:
            verify(self.entries, bytes(mutated))
        self.assertEqual(ctx.exception.offset, entry.offset)

    def test_out_of_range(self):
        with self.assertRaises(CorruptError):
            locate(self.entries, len(self.data))
        with self.assertRaises(CorruptError):
            locate(self.entries, -1)
        with self.assertRaises(CorruptError):
            locate([], 0)


if __name__ == "__main__":
    unittest.main()
