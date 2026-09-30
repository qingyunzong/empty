import os
import random
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

from sparseix import IndexCorrupt, Segment, check, index_path, load_index, read, write


class SparseixTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.target = os.path.join(self._tmp.name, "data.bin")

    def segments(self):
        return load_index(index_path(self.target))


class MergeTests(SparseixTestBase):
    def test_overlapping_writes_merge(self):
        write(self.target, 10, b"AAAAA")  # [10, 15)
        write(self.target, 14, b"BBBBBB")  # [14, 20) overlaps
        segs = self.segments()
        self.assertEqual(len(segs), 1)
        self.assertEqual((segs[0].start, segs[0].length), (10, 10))
        self.assertEqual(read(self.target, 10, 10), b"AAAABBBBBB")

    def test_adjacent_writes_merge(self):
        write(self.target, 10, b"AAAAA")  # [10, 15)
        write(self.target, 15, b"BBBBB")  # [15, 20) touches
        segs = self.segments()
        self.assertEqual(len(segs), 1)
        self.assertEqual((segs[0].start, segs[0].length), (10, 10))
        self.assertEqual(read(self.target, 10, 10), b"AAAAABBBBB")

    def test_disjoint_writes_stay_separate(self):
        write(self.target, 0, b"abc")
        write(self.target, 100, b"xy")
        segs = self.segments()
        self.assertEqual([(s.start, s.length) for s in segs], [(0, 3), (100, 2)])

    def test_write_bridging_two_segments_merges_all(self):
        write(self.target, 0, b"aaa")
        write(self.target, 10, b"bbb")
        write(self.target, 2, b"012345678")  # [2, 11) bridges both
        segs = self.segments()
        self.assertEqual(len(segs), 1)
        self.assertEqual((segs[0].start, segs[0].length), (0, 13))
        self.assertEqual(read(self.target, 0, 13), b"aa012345678bb")

    def test_contained_write_keeps_single_segment(self):
        write(self.target, 10, b"0123456789")
        write(self.target, 12, b"XX")
        segs = self.segments()
        self.assertEqual(len(segs), 1)
        self.assertEqual((segs[0].start, segs[0].length), (10, 10))
        self.assertEqual(read(self.target, 10, 10), b"01XX456789")

    def test_zero_length_write_forbidden(self):
        with self.assertRaises(ValueError):
            write(self.target, 5, b"")


class ReadTests(SparseixTestBase):
    def test_read_across_hole_zero_filled(self):
        write(self.target, 0, b"abc")
        write(self.target, 100, b"xy")
        data = read(self.target, 0, 102)
        self.assertEqual(data[:3], b"abc")
        self.assertEqual(data[3:100], b"\x00" * 97)
        self.assertEqual(data[100:102], b"xy")

    def test_read_from_empty_file(self):
        self.assertEqual(read(self.target, 0, 16), b"\x00" * 16)

    def test_read_past_last_segment(self):
        write(self.target, 4, b"zz")
        self.assertEqual(read(self.target, 4, 6), b"zz" + b"\x00" * 4)


class CorruptionTests(SparseixTestBase):
    def _write_two_segments(self):
        write(self.target, 0, b"aaa")
        write(self.target, 100, b"bb")

    def test_swapped_records_rejected(self):
        self._write_two_segments()
        path = index_path(self.target)
        with open(path, "rb") as fh:
            blob = bytearray(fh.read())
        rec = 20
        first = bytes(blob[12 : 12 + rec])
        second = bytes(blob[12 + rec : 12 + 2 * rec])
        blob[12 : 12 + rec] = second
        blob[12 + rec : 12 + 2 * rec] = first
        with open(path, "wb") as fh:
            fh.write(blob)
        with self.assertRaises(IndexCorrupt):
            load_index(path)
        with self.assertRaises(IndexCorrupt):
            read(self.target, 0, 1)

    def test_bad_magic_rejected(self):
        self._write_two_segments()
        path = index_path(self.target)
        with open(path, "r+b") as fh:
            fh.write(b"XXXX")
        with self.assertRaises(IndexCorrupt):
            load_index(path)

    def test_zero_length_record_rejected(self):
        path = index_path(self.target)
        blob = struct.pack("<4sII", b"SPIX", 1, 1) + struct.pack("<QQI", 5, 0, 0)
        with open(path, "wb") as fh:
            fh.write(blob)
        with self.assertRaises(IndexCorrupt):
            load_index(path)

    def test_truncated_index_rejected(self):
        self._write_two_segments()
        path = index_path(self.target)
        with open(path, "r+b") as fh:
            fh.truncate(20)
        with self.assertRaises(IndexCorrupt):
            load_index(path)

    def test_crc_mismatch_detected_by_check(self):
        self._write_two_segments()
        with open(self.target, "r+b") as fh:
            fh.seek(0)
            fh.write(b"zzz")
        with self.assertRaises(IndexCorrupt):
            check(self.target)

    def test_check_ok(self):
        self._write_two_segments()
        self.assertEqual(check(self.target), 2)


class CliTests(SparseixTestBase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "sparseix", *argv],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def test_write_read_check_roundtrip(self):
        proc = self.run_cli("write", self.target, "10", "deadbeef")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proc = self.run_cli("read", self.target, "8", "8")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "0000deadbeef0000")
        proc = self.run_cli("check", self.target)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OK", proc.stdout)

    def test_cli_check_fails_on_corruption(self):
        self.run_cli("write", self.target, "0", "aabbcc")
        with open(self.target, "r+b") as fh:
            fh.write(b"\x00")
        proc = self.run_cli("check", self.target)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("error", proc.stderr)


class RandomModelTests(SparseixTestBase):
    def test_random_writes_against_dict_model(self):
        rng = random.Random(20261001)
        model = {}
        span = 4096
        for step in range(300):
            off = rng.randrange(0, span)
            length = rng.randrange(1, 201)  # length <= 200
            data = bytes(rng.randrange(256) for _ in range(length))
            write(self.target, off, data)
            for i, byte in enumerate(data):
                model[off + i] = byte
            if step % 25 == 0:
                self.assertEqual(check(self.target), len(self.segments()))
        top = max(model) + 1
        expected = bytes(model.get(i, 0) for i in range(top))
        self.assertEqual(read(self.target, 0, top), expected)
        # Random point reads against the model.
        for _ in range(200):
            off = rng.randrange(0, top + 100)
            length = rng.randrange(0, 300)
            expected = bytes(model.get(i, 0) for i in range(off, off + length))
            self.assertEqual(read(self.target, off, length), expected)
        # Index invariants: strictly ascending, non-overlapping, non-adjacent.
        segs = self.segments()
        for prev, cur in zip(segs, segs[1:]):
            self.assertLess(prev.end, cur.start)
            self.assertEqual(prev.crc32, zlib.crc32(read(self.target, prev.start, prev.length)))


if __name__ == "__main__":
    unittest.main()
