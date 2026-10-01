"""R<=200 随机值与独立逐位参考打包器对照（含非字节对齐总位数）。"""

import random
import unittest

from colbit import dumps, loads
from colbit.writer import pack_column


def reference_pack(values, width):
    """逐位参考实现：第 i 个值的第 b 位写入全局位 i*width+b（字节内低位在前）。"""
    if width == 0:
        return b""
    nbits = len(values) * width
    out = bytearray((nbits + 7) // 8)
    for i, v in enumerate(values):
        for b in range(width):
            if (v >> b) & 1:
                pos = i * width + b
                out[pos // 8] |= 1 << (pos % 8)
    return bytes(out)


class TestAgainstReference(unittest.TestCase):
    def test_random_columns_match_reference(self):
        rng = random.Random(20261001)
        cases = 0
        for _ in range(60):
            nrows = rng.randrange(0, 201)  # R <= 200，含 R=0
            width = rng.choice([0, 1, 2, 3, 5, 7, 9, 13, 17, 31, 32])
            values = [rng.randrange(1 << width) if width else 0
                      for _ in range(nrows)]
            if width == 0:
                values = [0] * nrows
            expected = reference_pack(values, width)
            got = pack_column(values, width)
            self.assertEqual(got, expected,
                             f"width={width} rows={nrows}")
            # 覆盖非字节对齐总位数
            if (nrows * width) % 8 != 0:
                cases += 1
        self.assertGreater(cases, 0, "未覆盖非字节对齐情形")

    def test_non_byte_aligned_totals_explicit(self):
        rng = random.Random(7)
        for width, nrows in [(1, 3), (3, 5), (7, 9), (9, 7), (5, 3), (13, 11)]:
            self.assertNotEqual((width * nrows) % 8, 0)
            values = [rng.randrange(1 << width) for _ in range(nrows)]
            self.assertEqual(pack_column(values, width),
                             reference_pack(values, width))

    def test_full_file_random_roundtrip(self):
        rng = random.Random(99)
        for _ in range(30):
            ncols = rng.randrange(1, 6)
            nrows = rng.randrange(0, 201)
            widths = [rng.choice([0, 1, 7, 9, 32, rng.randrange(1, 33)])
                      for _ in range(ncols)]
            columns = [
                [rng.randrange(1 << w) if w else 0 for _ in range(nrows)]
                for w in widths
            ]
            data = dumps(columns, widths)
            dec = loads(data)
            batch = rng.randrange(1, 250)
            got = []
            for part in dec.iter_rows(batch):
                self.assertLessEqual(len(part), batch)
                got.extend(part)
            self.assertEqual(len(got), nrows)
            for c in range(ncols):
                self.assertEqual([r[c] for r in got], columns[c])


if __name__ == "__main__":
    unittest.main()
