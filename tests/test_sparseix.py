import os
import random
import struct
import subprocess
import sys
import tempfile
import unittest

from sparseix import IndexCorrupt, SparseFile
from sparseix.core import HEADER, MAGIC, RECORD, VERSION


class SparseixTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "data.bin")

    def open_sf(self):
        return SparseFile(self.path)


class MergeTests(SparseixTestBase):
    def test_adjacent_writes_merge(self):
        sf = self.open_sf()
        sf.write(10, b"AAAAA")   # [10, 15)
        sf.write(14, b"BBBBBB")  # [14, 20) overlaps/touches -> merge
        self.assertEqual(sf.segments, [(10, 10)])
        self.assertEqual(sf.read(10, 10), b"AAAA" + b"BBBBBB")

    def test_overlapping_write_overrides_and_merges(self):
        sf = self.open_sf()
        sf.write(0, b"A" * 10)
        sf.write(5, b"B" * 10)  # [5, 15) overrides tail of first segment
        self.assertEqual(sf.segments, [(0, 15)])
        self.assertEqual(sf.read(0, 15), b"A" * 5 + b"B" * 10)

    def test_bridging_write_merges_two_segments(self):
        sf = self.open_sf()
        sf.write(0, b"AA")
        sf.write(10, b"BB")
        self.assertEqual(len(sf.segments), 2)
        sf.write(2, b"C" * 8)  # bridges the gap exactly
        self.assertEqual(sf.segments, [(0, 12)])
        self.assertEqual(sf.read(0, 12), b"AA" + b"C" * 8 + b"BB")

    def test_disjoint_writes_stay_separate(self):
        sf = self.open_sf()
        sf.write(0, b"abc")
        sf.write(100, b"xy")
        self.assertEqual(sf.segments, [(0, 3), (100, 2)])

    def test_zero_length_write_forbidden(self):
        sf = self.open_sf()
        with self.assertRaises(ValueError):
            sf.write(5, b"")


class ReadTests(SparseixTestBase):
    def test_read_across_hole_returns_zero_fill(self):
        sf = self.open_sf()
        sf.write(0, b"abc")
        sf.write(100, b"xy")
        expected = b"abc" + b"\x00" * 97 + b"xy"
        self.assertEqual(sf.read(0, 102), expected)

    def test_read_unwritten_region_is_zero(self):
        sf = self.open_sf()
        self.assertEqual(sf.read(50, 10), b"\x00" * 10)

    def test_read_zero_length(self):
        sf = self.open_sf()
        sf.write(0, b"abc")
        self.assertEqual(sf.read(1, 0), b"")

    def test_persistence_across_instances(self):
        sf = self.open_sf()
        sf.write(7, b"hello")
        sf.write(1000, b"world")
        again = self.open_sf()
        self.assertEqual(again.segments, [(7, 5), (1000, 5)])
        self.assertEqual(again.read(7, 5), b"hello")
        self.assertEqual(again.read(0, 12), b"\x00" * 7 + b"hello")


class IndexFormatTests(SparseixTestBase):
    def test_index_file_layout(self):
        sf = self.open_sf()
        sf.write(10, b"abc")
        sf.write(100, b"de")
        with open(self.path + ".idx", "rb") as fh:
            raw = fh.read()
        magic, version, count = HEADER.unpack_from(raw, 0)
        self.assertEqual(magic, MAGIC)
        self.assertEqual(version, VERSION)
        self.assertEqual(count, 2)
        self.assertEqual(len(raw), HEADER.size + 2 * RECORD.size)
        starts = []
        off = HEADER.size
        for _ in range(count):
            start, length, _crc = RECORD.unpack_from(raw, off)
            starts.append(start)
            self.assertGreater(length, 0)
            off += RECORD.size
        self.assertEqual(starts, sorted(starts))

    def test_swapped_records_raise_index_corrupt(self):
        sf = self.open_sf()
        sf.write(0, b"aa")
        sf.write(100, b"bb")
        idx = self.path + ".idx"
        with open(idx, "rb") as fh:
            raw = bytearray(fh.read())
        rec0 = raw[HEADER.size : HEADER.size + RECORD.size]
        rec1 = raw[HEADER.size + RECORD.size : HEADER.size + 2 * RECORD.size]
        raw[HEADER.size : HEADER.size + RECORD.size] = rec1
        raw[HEADER.size + RECORD.size : HEADER.size + 2 * RECORD.size] = rec0
        with open(idx, "wb") as fh:
            fh.write(raw)
        with self.assertRaises(IndexCorrupt):
            self.open_sf()

    def test_bad_magic_raises_index_corrupt(self):
        sf = self.open_sf()
        sf.write(0, b"aa")
        with open(self.path + ".idx", "r+b") as fh:
            fh.write(b"XXXX")
        with self.assertRaises(IndexCorrupt):
            self.open_sf()

    def test_crc_mismatch_raises_index_corrupt(self):
        sf = self.open_sf()
        sf.write(10, b"abc")
        with open(self.path, "r+b") as fh:
            fh.seek(10)
            fh.write(b"X")
        with self.assertRaises(IndexCorrupt):
            self.open_sf()

    def test_zero_length_record_raises_index_corrupt(self):
        sf = self.open_sf()
        sf.write(0, b"aa")
        idx = self.path + ".idx"
        with open(idx, "r+b") as fh:
            fh.seek(HEADER.size)
            fh.write(struct.pack("<QQI", 0, 0, 0))
        with self.assertRaises(IndexCorrupt):
            self.open_sf()


class RandomModelTests(SparseixTestBase):
    def test_random_writes_against_dict_model(self):
        rng = random.Random(20261001)
        sf = self.open_sf()
        model = {}
        for _ in range(300):
            off = rng.randrange(0, 2000)
            length = rng.randrange(1, 201)  # length <= 200
            data = bytes(rng.randrange(256) for _ in range(length))
            sf.write(off, data)
            for i, byte in enumerate(data):
                model[off + i] = byte
            self._assert_invariants(sf)
        hi = max(model) + 1
        expected = bytes(model.get(i, 0) for i in range(hi))
        self.assertEqual(sf.read(0, hi), expected)
        # Spot-check random windows, including ranges past the end.
        for _ in range(200):
            off = rng.randrange(0, hi + 100)
            n = rng.randrange(0, 300)
            want = bytes(model.get(i, 0) for i in range(off, off + n))
            self.assertEqual(sf.read(off, n), want)
        # A fresh instance must see identical bytes (index + data on disk).
        again = self.open_sf()
        self.assertEqual(again.read(0, hi), expected)

    def _assert_invariants(self, sf):
        segs = sf.segments
        for prev, cur in zip(segs, segs[1:]):
            prev_start, prev_len = prev
            cur_start, cur_len = cur
            self.assertGreater(cur_start, prev_start)
            self.assertGreater(cur_start, prev_start + prev_len)  # no overlap/adjacency
        for _start, length in segs:
            self.assertGreater(length, 0)


class CliTests(SparseixTestBase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "sparseix", *args],
            capture_output=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def test_write_read_check_roundtrip(self):
        proc = self.run_cli("write", self.path, "10", "68656c6c6f", "--hex")
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        proc = self.run_cli("read", self.path, "10", "5", "--hex")
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertEqual(proc.stdout.decode().strip(), "68656c6c6f")
        proc = self.run_cli("read", self.path, "8", "5", "--hex")
        self.assertEqual(proc.stdout.decode().strip(), "000068656c")
        proc = self.run_cli("check", self.path)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        self.assertIn(b"OK", proc.stdout)

    def test_cli_check_fails_on_corrupt_index(self):
        proc = self.run_cli("write", self.path, "0", "aa", "--hex")
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        with open(self.path + ".idx", "r+b") as fh:
            fh.write(b"XXXX")
        proc = self.run_cli("check", self.path)
        self.assertEqual(proc.returncode, 1)
        self.assertIn(b"error", proc.stderr)


if __name__ == "__main__":
    unittest.main()
