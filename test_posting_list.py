"""posting_list 模块的单元测试（标准库 unittest）。"""

import unittest

from posting_list import (
    CorruptedDeltaError,
    PostingList,
    difference,
    intersect,
    union,
)


class TestEncoding(unittest.TestCase):
    def test_roundtrip(self):
        ids = [1, 2, 3, 5, 8, 13, 21, 100, 10_000, 1_000_000]
        pl = PostingList(ids, block_size=4)
        self.assertEqual(pl.decode_all(), ids)
        self.assertEqual(list(pl), ids)

    def test_serialize_roundtrip(self):
        ids = [3, 7, 8, 9, 50, 51, 52, 53, 900]
        pl = PostingList.from_bytes(PostingList(ids, block_size=4).to_bytes())
        self.assertEqual(pl.decode_all(), ids)
        self.assertEqual(len(pl), len(ids))

    def test_empty_list(self):
        pl = PostingList()
        self.assertEqual(pl.decode_all(), [])
        self.assertEqual(len(pl), 0)
        self.assertEqual(PostingList.from_bytes(pl.to_bytes()).decode_all(), [])

    def test_strictly_increasing_enforced_at_build(self):
        with self.assertRaises(ValueError):
            PostingList([1, 2, 2])  # 重复
        with self.assertRaises(ValueError):
            PostingList([5, 3])  # 倒退
        with self.assertRaises(ValueError):
            PostingList([0])  # 非正
        with self.assertRaises(ValueError):
            PostingList([-4])


class TestAdvance(unittest.TestCase):
    def setUp(self):
        # 1..40，块大小 4，共 10 个块；块 i 的最大ID为 4*(i+1)
        self.ids = list(range(1, 41))
        self.pl = PostingList(self.ids, block_size=4)

    def test_advance_to_current_does_not_skip(self):
        cursor = self.pl.cursor()
        self.assertEqual(cursor.next(), 1)
        self.assertEqual(cursor.next(), 2)
        before = self.pl.stats.decoded_blocks
        # advance 到当前ID：不跳过、不额外解码，仍返回当前ID
        self.assertEqual(cursor.advance(2), 2)
        self.assertEqual(cursor.current, 2)
        self.assertEqual(self.pl.stats.decoded_blocks, before)
        # advance 到更小的值同样不动
        self.assertEqual(cursor.advance(1), 2)
        # 之后 next 正常前进
        self.assertEqual(cursor.next(), 3)

    def test_advance_within_block(self):
        cursor = self.pl.cursor()
        self.assertEqual(cursor.advance(3), 3)
        self.assertEqual(self.pl.stats.decoded_blocks, 1)
        self.assertEqual(self.pl.stats.skipped_blocks, 0)

    def test_advance_skips_whole_blocks(self):
        cursor = self.pl.cursor()
        # 37 落在第 10 块（37..40），前 9 块整块跳过，只解码 1 块
        self.assertEqual(cursor.advance(37), 37)
        self.assertEqual(self.pl.stats.decoded_blocks, 1)
        self.assertEqual(self.pl.stats.skipped_blocks, 9)

    def test_advance_lands_on_next_id_when_target_absent(self):
        cursor = self.pl.cursor()
        pl = PostingList([10, 20, 30], block_size=2)
        cursor = pl.cursor()
        self.assertEqual(cursor.advance(15), 20)

    def test_advance_beyond_end(self):
        cursor = self.pl.cursor()
        self.assertIsNone(cursor.advance(1000))
        self.assertTrue(cursor.exhausted)
        self.assertIsNone(cursor.next())
        self.assertIsNone(cursor.advance(1))

    def test_advance_on_empty_list(self):
        cursor = PostingList().cursor()
        self.assertIsNone(cursor.advance(5))
        self.assertIsNone(cursor.next())

    def test_mixed_next_and_advance(self):
        cursor = self.pl.cursor()
        self.assertEqual(cursor.next(), 1)
        self.assertEqual(cursor.advance(10), 10)
        self.assertEqual(cursor.next(), 11)
        self.assertEqual(cursor.advance(40), 40)
        self.assertIsNone(cursor.next())


class TestSetOperations(unittest.TestCase):
    def check_ops(self, ids_a, ids_b):
        a, b = PostingList(ids_a), PostingList(ids_b)
        set_a, set_b = set(ids_a), set(ids_b)
        self.assertEqual(intersect(a, b), sorted(set_a & set_b))
        self.assertEqual(union(a, b), sorted(set_a | set_b))
        self.assertEqual(difference(a, b), sorted(set_a - set_b))

    def test_basic(self):
        self.check_ops([1, 3, 5, 7, 9], [3, 4, 5, 6])

    def test_disjoint_and_subset(self):
        self.check_ops([1, 2, 3], [10, 20])
        self.check_ops([1, 2, 3, 4, 5], [2, 4])

    def test_empty_combinations(self):
        empty, nonempty = [], [2, 4, 6]
        self.check_ops(empty, nonempty)
        self.check_ops(nonempty, empty)
        self.check_ops(empty, empty)

    def test_large_lists_with_skipping(self):
        ids_a = list(range(1, 3001, 3))
        ids_b = list(range(1, 3001, 5))
        a = PostingList(ids_a, block_size=16)
        b = PostingList(ids_b, block_size=16)
        result = intersect(a, b)
        self.assertEqual(result, sorted(set(ids_a) & set(ids_b)))
        # advance 让两边都跳过了若干整块
        self.assertGreater(a.stats.skipped_blocks + b.stats.skipped_blocks, 0)


class TestDecodeStats(unittest.TestCase):
    def test_full_decode_counts_every_block(self):
        pl = PostingList(range(1, 41), block_size=4)
        pl.decode_all()
        self.assertEqual(pl.stats.decoded_blocks, 10)
        self.assertEqual(pl.stats.skipped_blocks, 0)

    def test_reset_stats(self):
        pl = PostingList(range(1, 9), block_size=4)
        pl.decode_all()
        pl.reset_stats()
        self.assertEqual(pl.stats.decoded_blocks, 0)


class TestCorruptedData(unittest.TestCase):
    def test_negative_delta_rejected(self):
        # 手工构造：block_size=4, count=2, 1 块, last_id=5, 负载长度 2
        # 负载首字节 0x01 -> zigzag 解码为 -1（倒退差分），必须拒绝
        data = bytes([4, 2, 1, 5, 2, 0x01, 0x08])
        pl = PostingList.from_bytes(data)
        with self.assertRaises(CorruptedDeltaError):
            pl.decode_all()

    def test_zero_delta_rejected(self):
        # 0x00 -> zigzag 解码为 0（重复ID），必须拒绝
        data = bytes([4, 2, 1, 5, 2, 0x00, 0x08])
        pl = PostingList.from_bytes(data)
        with self.assertRaises(CorruptedDeltaError):
            pl.decode_all()

    def test_truncated_varint_rejected(self):
        # 负载只有 0x80（continuation 位置位却无后续字节）
        data = bytes([4, 1, 1, 5, 1, 0x80])
        pl = PostingList.from_bytes(data)
        with self.assertRaises(CorruptedDeltaError):
            pl.decode_all()

    def test_skip_table_mismatch_rejected(self):
        # 跳跃表声称块末ID=6，但差分实际累加到 5
        data = bytes([4, 1, 1, 6, 1, 0x0A])
        pl = PostingList.from_bytes(data)
        with self.assertRaises(CorruptedDeltaError):
            pl.decode_all()

    def test_payload_length_mismatch_rejected(self):
        data = bytes([4, 1, 1, 5, 3, 0x0A])  # 声称负载 3 字节，实际 1 字节
        with self.assertRaises(CorruptedDeltaError):
            PostingList.from_bytes(data)

    def test_flipped_byte_in_real_payload_rejected(self):
        pl = PostingList([5, 9, 12], block_size=4)
        raw = bytearray(pl.to_bytes())
        raw[-1] = 0x01  # 最后一个差分改成 zigzag(-1)
        with self.assertRaises(CorruptedDeltaError):
            PostingList.from_bytes(bytes(raw)).decode_all()


if __name__ == "__main__":
    unittest.main()
