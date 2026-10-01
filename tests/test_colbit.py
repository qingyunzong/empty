import os
import random
import struct
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import colbit


def reference_pack(values, w):
    """Bit-by-bit reference packer: value bit j -> stream bit i*w + j."""
    if w == 0:
        return b""
    bits = []
    for v in values:
        for j in range(w):
            bits.append((v >> j) & 1)
    out = bytearray()
    for i in range(0, len(bits), 8):
        byte = 0
        for k, bit in enumerate(bits[i:i + 8]):
            byte |= bit << k
        out.append(byte)
    return bytes(out)


class ColbitTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "data.colbit")

    def roundtrip(self, columns, widths, batch=7):
        colbit.write_file(self.path, columns, widths)
        reader = colbit.ColbitReader(self.path)
        got = []
        for rows in reader.iter_rows(batch):
            self.assertLessEqual(len(rows), batch)
            got.extend(rows)
        expected = [tuple(col[i] for col in columns)
                    for i in range(len(columns[0]) if columns else 0)]
        self.assertEqual(got, expected)


class BoundaryRoundtripTest(ColbitTestBase):
    def test_width_boundaries(self):
        rng = random.Random(42)
        for w in (1, 7, 9, 32):
            with self.subTest(w=w):
                values = [rng.getrandbits(w) for _ in range(50)]
                # include extremes
                values[0] = 0
                values[1] = (1 << w) - 1
                self.roundtrip([values], [w])


class EdgeCaseTest(ColbitTestBase):
    def test_zero_rows(self):
        colbit.write_file(self.path, [[], []], [3, 0])
        reader = colbit.ColbitReader(self.path)
        self.assertEqual(reader.nrows, 0)
        self.assertEqual(list(reader.iter_rows(5)), [])

    def test_batch_larger_than_rows(self):
        colbit.write_file(self.path, [[10, 20, 30]], [9])
        reader = colbit.ColbitReader(self.path)
        batches = list(reader.iter_rows(1000))
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0], [(10,), (20,), (30,)])

    def test_w0_stores_no_data_and_decodes_zeros(self):
        colbit.write_file(self.path, [[0, 0, 0, 0], [1, 2, 3, 4]], [0, 3])
        with open(self.path, "rb") as fh:
            blob = fh.read()
        # w=0 column contributes 0 bytes; only the 3-bit column has data
        self.assertEqual(len(blob), colbit._HEADER.size
                         + 2 * colbit._COL_HEADER.size
                         + colbit.column_data_size(4, 3))
        reader = colbit.ColbitReader(self.path)
        rows = [r for batch in reader.iter_rows(3) for r in batch]
        self.assertEqual(rows, [(0, 1), (0, 2), (0, 3), (0, 4)])

    def test_declared_bits_exceed_capacity(self):
        colbit.write_file(self.path, [[1, 2, 3]], [9])
        with open(self.path, "rb") as fh:
            blob = fh.read()
        with open(self.path, "wb") as fh:
            fh.write(blob[:-1])  # truncate one data byte
        with self.assertRaises(colbit.FormatError):
            colbit.ColbitReader(self.path)

    def test_string_column_forbidden(self):
        with self.assertRaises(ValueError):
            colbit.write_file(self.path, [["a"]], [8])
        # craft a file whose column header declares the string type
        colbit.write_file(self.path, [[1]], [8])
        with open(self.path, "rb") as fh:
            blob = bytearray(fh.read())
        blob[colbit._HEADER.size] = colbit.TYPE_STRING
        with open(self.path, "wb") as fh:
            fh.write(blob)
        with self.assertRaises(colbit.FormatError):
            colbit.ColbitReader(self.path)


class CrcTest(ColbitTestBase):
    def _flip_column_bit(self, ncols, widths, rows, target):
        colbit.write_file(
            self.path,
            [[(i * 7 + c) & ((1 << widths[c]) - 1) if widths[c] else 0
              for i in range(rows)] for c in range(ncols)],
            widths,
        )
        with open(self.path, "rb") as fh:
            blob = bytearray(fh.read())
        off = colbit._HEADER.size + ncols * colbit._COL_HEADER.size
        off += sum(colbit.column_data_size(rows, w) for w in widths[:target])
        blob[off] ^= 0x01  # flip one bit in the target column's data
        with open(self.path, "wb") as fh:
            fh.write(blob)

    def test_crc_error_reports_column_2(self):
        self._flip_column_bit(4, [5, 5, 5, 5], 10, target=2)
        reader = colbit.ColbitReader(self.path)
        with self.assertRaises(colbit.CrcMismatchError) as ctx:
            for _ in reader.iter_rows(4):
                pass
        self.assertEqual(ctx.exception.column, 2)
        self.assertIn("column 2", str(ctx.exception))

    def test_select_subset_skips_unselected_corrupt_column(self):
        self._flip_column_bit(3, [4, 4, 4], 6, target=1)
        # selecting only columns 0 and 2 must not touch the corrupt column 1
        reader = colbit.ColbitReader(self.path, columns=[0, 2])
        rows = [r for batch in reader.iter_rows(2) for r in batch]
        self.assertEqual(len(rows), 6)
        # selecting the corrupt column raises
        reader2 = colbit.ColbitReader(self.path, columns=[1])
        with self.assertRaises(colbit.CrcMismatchError):
            list(reader2.iter_rows(2))


class ReferenceComparisonTest(ColbitTestBase):
    def test_random_against_bitwise_reference(self):
        rng = random.Random(2024)
        for trial in range(30):
            rows = rng.randint(1, 200)
            ncols = rng.randint(1, 5)
            widths = [rng.choice([0, 1, 2, 3, 5, 7, 9, 13, 17, 31, 32])
                      for _ in range(ncols)]
            columns = [
                [rng.getrandbits(w) if w else 0 for _ in range(rows)]
                for w in widths
            ]
            with self.subTest(trial=trial, rows=rows, widths=widths):
                colbit.write_file(self.path, columns, widths)
                with open(self.path, "rb") as fh:
                    blob = fh.read()
                off = colbit._HEADER.size + ncols * colbit._COL_HEADER.size
                total_bits = 0
                for col, w in zip(columns, widths):
                    size = colbit.column_data_size(rows, w)
                    section = blob[off:off + size]
                    self.assertEqual(section, reference_pack(col, w))
                    off += size
                    total_bits += rows * w
                # covers non-byte-aligned total bit counts
                self.assertEqual(len(blob), off)
                # full decode roundtrip
                reader = colbit.ColbitReader(self.path)
                got = [r for batch in reader.iter_rows(rng.randint(1, 64))
                       for r in batch]
                expected = [tuple(col[i] for col in columns)
                            for i in range(rows)]
                self.assertEqual(got, expected)

    def test_non_byte_aligned_total_bits(self):
        # 3 rows x 3 bits = 9 bits -> 2 bytes, not byte aligned
        values = [0b101, 0b011, 0b111]
        self.assertEqual(colbit.pack_values(values, 3),
                         reference_pack(values, 3))
        self.assertEqual(len(colbit.pack_values(values, 3)), 2)


class CliTest(ColbitTestBase):
    def _run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "colbit", *argv],
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def test_create_select_info(self):
        proc = self._run_cli("create", self.path,
                             "--widths", "1,7,9,32", "--rows", "17",
                             "--seed", "5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proc = self._run_cli("info", self.path)
        self.assertIn("columns: 4", proc.stdout)
        self.assertIn("rows: 17", proc.stdout)
        proc = self._run_cli("select", self.path, "--batch", "4")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [l for l in proc.stdout.strip().splitlines() if l]
        self.assertEqual(len(lines), 17)
        self.assertTrue(all(len(l.split(",")) == 4 for l in lines))

    def test_select_column_subset(self):
        columns = [[1, 2, 3], [10, 20, 30], [100, 200, 300]]
        colbit.write_file(self.path, columns, [2, 5, 9])
        proc = self._run_cli("select", self.path, "0", "2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(lines, ["1,100", "2,200", "3,300"])


if __name__ == "__main__":
    unittest.main()
