import random
import unittest

from rchunk import (
    MAX_SIZE,
    MIN_SIZE,
    MASK,
    Chunker,
    RollingHash,
    chunk_stream,
    dumps,
    entries_from_data,
)
from tests.reference import reference_chunks


def chunked(chunker, data, buffer_size):
    chunks = []
    for i in range(0, len(data), buffer_size):
        chunks.extend(chunker.feed(data[i:i + buffer_size]))
    chunks.extend(chunker.finish())
    return chunks


class TestChunker(unittest.TestCase):
    def test_all_zero_1mib_cuts_only_at_max(self):
        data = b"\x00" * (1024 * 1024)
        chunks = chunk_stream(data, 65536)
        self.assertEqual(len(chunks), 256)
        for offset, length in chunks:
            self.assertEqual(length, MAX_SIZE)
        self.assertEqual([off for off, _ in chunks], [i * MAX_SIZE for i in range(256)])
        # zeros never produce a fingerprint match, so no other cut exists
        h = RollingHash()
        for _ in range(4096):
            h.update(0)
            self.assertFalse(h.boundary())

    def test_buffer_size_independence(self):
        rng = random.Random(20261001)
        data = rng.randbytes(300_000)
        results = {size: chunked(Chunker(), data, size) for size in (8, 4096, 65536)}
        self.assertEqual(results[8], results[4096])
        self.assertEqual(results[4096], results[65536])
        indexes = {
            size: dumps(entries_from_data(data, chunks))
            for size, chunks in results.items()
        }
        self.assertEqual(indexes[8], indexes[4096])
        self.assertEqual(indexes[4096], indexes[65536])
        # offsets tile the stream contiguously
        expected = 0
        for offset, length in results[8]:
            self.assertEqual(offset, expected)
            expected = offset + length
        self.assertEqual(expected, len(data))

    def test_min_size_respected(self):
        rng = random.Random(7)
        data = rng.randbytes(200_000)
        chunks = chunk_stream(data, 4096)
        for offset, length in chunks[:-1]:
            self.assertGreaterEqual(length, MIN_SIZE)
            self.assertLessEqual(length, MAX_SIZE)

    def test_forced_cut_tie_takes_limit(self):
        # Crafted so the fingerprint matches exactly on the byte that
        # reaches MAX_SIZE: 4094 zero bytes keep the hash at 0, then
        # 0xff, 0x00 make h = 255*257 = 65535, whose low 13 bits are all 1.
        prefix = b"\x00" * (MAX_SIZE - 2) + b"\xff\x00"
        h = RollingHash()
        for byte in prefix:
            h.update(byte)
        self.assertTrue(h.boundary())  # fingerprint fires exactly at the limit
        tail = b"tail-after-forced-cut"
        chunks = chunk_stream(prefix + tail, 65536)
        self.assertEqual(chunks[0], (0, MAX_SIZE))
        self.assertEqual(chunks[1], (MAX_SIZE, len(tail)))
        self.assertEqual(chunks, reference_chunks(prefix + tail))

    def test_matches_reference_up_to_3000(self):
        rng = random.Random(424242)
        data = rng.randbytes(3000)
        for n in range(0, 3001):
            prefix = data[:n]
            expected = reference_chunks(prefix)
            for buffer_size in (8, 4096):
                actual = chunked(Chunker(), prefix, buffer_size)
                self.assertEqual(
                    actual, expected, f"mismatch at length {n}, buffer {buffer_size}"
                )

    def test_matches_reference_patterned_data(self):
        patterns = [
            b"\x00" * 3000,
            bytes(i % 256 for i in range(3000)),
            b"\xff" * 3000,
            (b"\x00" * 63 + b"\xff") * 46,
        ]
        for data in patterns:
            self.assertEqual(chunk_stream(data, 8), reference_chunks(data))
            self.assertEqual(chunk_stream(data, 4096), reference_chunks(data))

    def test_empty_input(self):
        self.assertEqual(chunk_stream(b"", 8), [])
        self.assertEqual(reference_chunks(b""), [])

    def test_eof_cut_below_min_size(self):
        data = b"short"
        self.assertEqual(chunk_stream(data, 2), [(0, 5)])


if __name__ == "__main__":
    unittest.main()
