"""CRC 惰性校验：翻转第 2 列一位，iter_rows 必须报列 2。"""

import unittest

from colbit import CrcError, dumps, loads
from colbit.format import COL_HEADER_SIZE, HEADER_SIZE, column_data_size


def build():
    widths = [3, 5, 9, 1]
    columns = [
        [1, 2, 3, 4, 5],
        [7, 8, 9, 10, 11],
        [100, 200, 300, 400, 500],
        [0, 1, 0, 1, 1],
    ]
    return dumps(columns, widths), widths


def column_data_offset(widths, rows, col_idx):
    off = HEADER_SIZE + len(widths) * COL_HEADER_SIZE
    for i in range(col_idx):
        off += column_data_size(rows, widths[i])
    return off


class TestCrc(unittest.TestCase):
    def test_flip_bit_in_column_2_reports_column_2(self):
        data, widths = build()
        off = column_data_offset(widths, 5, 2)
        corrupted = bytearray(data)
        corrupted[off] ^= 0x01  # 翻转第 2 列数据最低位
        dec = loads(bytes(corrupted))
        with self.assertRaises(CrcError) as ctx:
            list(dec.iter_rows(2))
        self.assertEqual(ctx.exception.column, 2)
        self.assertIn("column 2", str(ctx.exception))

    def test_flip_bit_in_column_0_reports_column_0(self):
        data, widths = build()
        off = column_data_offset(widths, 5, 0)
        corrupted = bytearray(data)
        corrupted[off] ^= 0x80
        with self.assertRaises(CrcError) as ctx:
            list(loads(bytes(corrupted)).iter_rows(3))
        self.assertEqual(ctx.exception.column, 0)

    def test_lazy_check_only_selected_columns(self):
        # 只 select 未损坏的列时不触发第 2 列校验
        data, widths = build()
        off = column_data_offset(widths, 5, 2)
        corrupted = bytearray(data)
        corrupted[off] ^= 0x01
        dec = loads(bytes(corrupted), columns=[0, 3])
        rows = []
        for part in dec.iter_rows(2):
            rows.extend(part)
        self.assertEqual(rows, [(1, 0), (2, 1), (3, 0), (4, 1), (5, 1)])
        # 但 select 含第 2 列时必须报错
        dec2 = loads(bytes(corrupted), columns=[1, 2])
        with self.assertRaises(CrcError) as ctx:
            list(dec2.iter_rows(2))
        self.assertEqual(ctx.exception.column, 2)

    def test_clean_file_passes(self):
        data, _ = build()
        rows = []
        for part in loads(data).iter_rows(2):
            rows.extend(part)
        self.assertEqual(len(rows), 5)


if __name__ == "__main__":
    unittest.main()
