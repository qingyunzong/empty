"""边界位宽往返、R=0、batch>R、w=0 全零列、非法输入。"""

import random
import unittest

from colbit import FormatError, dumps, loads
from colbit.writer import pack_column


def roundtrip(columns, widths, batch=7, columns_sel=None):
    data = dumps(columns, widths)
    dec = loads(data, columns=columns_sel)
    rows = []
    for part in dec.iter_rows(batch):
        assert len(part) <= batch
        rows.extend(part)
    return rows


class TestBoundaryWidths(unittest.TestCase):
    def test_width_1(self):
        col = [0, 1, 1, 0, 1, 0, 0, 1, 1]  # 9 位，非字节对齐
        rows = roundtrip([col], [1], batch=4)
        self.assertEqual([r[0] for r in rows], col)

    def test_width_7(self):
        col = [0, 1, 127, 126, 64, 0, 127, 3, 100, 127, 0]
        rows = roundtrip([col], [7], batch=3)
        self.assertEqual([r[0] for r in rows], col)

    def test_width_9(self):
        col = [0, 1, 511, 510, 256, 255, 0, 511, 129]
        rows = roundtrip([col], [9], batch=5)
        self.assertEqual([r[0] for r in rows], col)

    def test_width_32(self):
        col = [0, 1, 0xFFFFFFFF, 0x80000000, 0x7FFFFFFF, 123456789]
        rows = roundtrip([col], [32], batch=2)
        self.assertEqual([r[0] for r in rows], col)

    def test_all_boundary_widths_mixed(self):
        rng = random.Random(1234)
        widths = [1, 7, 9, 32]
        nrows = 53
        columns = [
            [rng.randrange(1 << w) for _ in range(nrows)] for w in widths
        ]
        # 每列头尾放极值
        for i, w in enumerate(widths):
            columns[i][0] = 0
            columns[i][-1] = (1 << w) - 1
        rows = roundtrip(columns, widths, batch=16)
        self.assertEqual(len(rows), nrows)
        for i in range(len(widths)):
            self.assertEqual([r[i] for r in rows], columns[i])

    def test_width_zero_column_is_all_zero_and_stores_nothing(self):
        columns = [[5, 6, 7], [0, 0, 0]]
        data = dumps(columns, [3, 0])
        # w=0 列不得存储数据：文件大小 = 头 + 2 列头 + 3*3 位 -> 2 字节
        self.assertEqual(len(data), 9 + 12 + 2)
        rows = roundtrip(columns, [3, 0], batch=2)
        self.assertEqual(rows, [(5, 0), (6, 0), (7, 0)])

    def test_value_out_of_range_rejected(self):
        with self.assertRaises(ValueError):
            pack_column([2], 1)
        with self.assertRaises(ValueError):
            pack_column([1 << 32], 32)
        with self.assertRaises(ValueError):
            pack_column([-1], 7)


class TestEdgeShapes(unittest.TestCase):
    def test_zero_rows(self):
        data = dumps([[], []], [1, 32])
        dec = loads(data)
        self.assertEqual(dec.nrows, 0)
        self.assertEqual(list(dec.iter_rows(10)), [])

    def test_batch_larger_than_rows(self):
        col = list(range(20))
        data = dumps([col], [5])
        dec = loads(data)
        parts = list(dec.iter_rows(1000))
        self.assertEqual(len(parts), 1)
        self.assertEqual([r[0] for r in parts[0]], col)

    def test_zero_rows_batch_larger(self):
        data = dumps([[]], [9])
        self.assertEqual(list(loads(data).iter_rows(500)), [])

    def test_batch_must_be_positive(self):
        data = dumps([[1]], [1])
        with self.assertRaises(ValueError):
            list(loads(data).iter_rows(0))

    def test_column_subset_selection(self):
        columns = [[1, 2, 3], [10, 20, 30], [100, 200, 300]]
        data = dumps(columns, [2, 5, 9])
        dec = loads(data, columns=[2, 0])
        rows = []
        for part in dec.iter_rows(2):
            rows.extend(part)
        self.assertEqual(rows, [(100, 1), (200, 2), (300, 3)])
        self.assertEqual(dec.selected_columns, [2, 0])

    def test_bad_magic_and_truncation(self):
        data = dumps([[1, 0]], [1])
        with self.assertRaises(FormatError):
            loads(b"XXXX" + data[4:])
        # 声明位长超出实际容量：截掉列数据最后一字节
        data2 = dumps([[1] * 16], [9])  # 144 位 = 18 字节
        with self.assertRaises(FormatError):
            list(loads(data2[:-1]).iter_rows(4))

    def test_invalid_width_in_header(self):
        data = bytearray(dumps([[1]], [1]))
        data[9 + 1] = 33  # 第 0 列 w=33 非法
        with self.assertRaises(FormatError):
            loads(bytes(data))

    def test_string_column_forbidden(self):
        from colbit.format import TYPE_STRING
        with self.assertRaises(ValueError):
            dumps([["a", "b"]], [8], types=[TYPE_STRING])
        data = bytearray(dumps([[1]], [1]))
        data[9] = TYPE_STRING  # 伪造字符串列类型
        with self.assertRaises(FormatError):
            loads(bytes(data))


if __name__ == "__main__":
    unittest.main()
