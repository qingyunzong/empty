"""postings / index 的 unittest 测试套件（仅标准库）。"""
import random
import unittest

from index import InvertedIndex, tokenize
from postings import (
    CorruptPostingsError,
    PostingsList,
    difference,
    encode,
    intersect,
    union,
)


def corrupt(data: bytes, offset: int, value: int) -> bytes:
    buf = bytearray(data)
    buf[offset] = value
    return bytes(buf)


class EncodeDecodeTest(unittest.TestCase):
    def test_roundtrip_multi_block(self):
        ids = [0, 1, 2, 5, 8, 13, 21, 34, 55, 89, 144, 1000, 10**6]
        for block_size in (1, 2, 3, 8, 64):
            plist = PostingsList(ids, block_size=block_size)
            self.assertEqual(plist.to_list(), ids)

    def test_roundtrip_empty_and_single(self):
        self.assertEqual(PostingsList([]).to_list(), [])
        self.assertEqual(PostingsList([42]).to_list(), [42])
        self.assertEqual(PostingsList([0]).to_list(), [0])

    def test_from_bytes_roundtrip(self):
        plist = PostingsList([3, 7, 100])
        clone = PostingsList.from_bytes(plist.to_bytes())
        self.assertEqual(clone.to_list(), [3, 7, 100])
        self.assertEqual(clone, plist)

    def test_strictly_increasing_enforced_at_build(self):
        for bad in ([1, 1], [5, 3], [2, 2, 3], [0, 0]):
            with self.assertRaises(ValueError, msg=f"应拒绝 {bad}"):
                PostingsList(bad)

    def test_non_int_rejected(self):
        for bad in (["1"], [1.5], [True], [None]):
            with self.assertRaises(TypeError, msg=f"应拒绝 {bad}"):
                PostingsList(bad)


class CorruptionTest(unittest.TestCase):
    """损坏差分/块头导致倒退或不一致时必须拒绝。"""

    def setUp(self):
        self.ids = [10, 20, 30, 40]
        self.data = encode(self.ids, block_size=2)

    def test_zero_delta_rejected(self):
        # 单块 [10, 20, 30]：头 3 字节，负载为差分 [11, 10, 10]
        data = encode([10, 20, 30], block_size=3)
        bad = corrupt(data, 4, 0)  # 第二个差分 -> 0（ID 不再递增）
        with self.assertRaises(CorruptPostingsError):
            PostingsList.from_bytes(bad).to_list()

    def test_block_target_regression_rejected(self):
        # 两块各 2 条；把第二块头中的 last_doc_id(=40) 改成 5（<= 前块末ID 20）
        # 布局: [count,last,plen,payload...] [count,last,plen,payload...]
        # 第一块 3 头字节 + 2 负载字节 = 5 字节，第二块 last 在偏移 6
        bad = corrupt(self.data, 6, 5)
        with self.assertRaises(CorruptPostingsError):
            PostingsList.from_bytes(bad).to_list()

    def test_truncated_payload_rejected(self):
        with self.assertRaises(CorruptPostingsError):
            PostingsList.from_bytes(self.data[:-1]).to_list()

    def test_block_checksum_mismatch_rejected(self):
        # 篡改负载使解码末ID与块头声明不符：改最后一个差分 10 -> 9
        bad = corrupt(self.data, len(self.data) - 1, 9)
        with self.assertRaises(CorruptPostingsError):
            PostingsList.from_bytes(bad).to_list()

    def test_truncated_varint_rejected(self):
        bad = self.data[:3] + b"\x80"  # 悬空 continuation bit
        with self.assertRaises(CorruptPostingsError):
            PostingsList.from_bytes(bad).to_list()


class AdvanceTest(unittest.TestCase):
    def setUp(self):
        self.ids = [2, 5, 7, 11, 13, 17, 19, 23, 29, 31]
        self.plist = PostingsList(self.ids, block_size=3)

    def test_advance_to_current_does_not_skip(self):
        reader = self.plist.reader()
        self.assertEqual(reader.next(), 2)
        decoded = reader.blocks_decoded
        self.assertEqual(reader.advance(2), 2)   # 到当前ID：不跳过
        self.assertEqual(reader.advance(1), 2)   # 更小目标：不移动
        self.assertEqual(reader.blocks_decoded, decoded)
        self.assertEqual(reader.next(), 5)       # 未丢条目

    def test_advance_within_block(self):
        reader = self.plist.reader()
        self.assertEqual(reader.advance(6), 7)
        self.assertEqual(reader.blocks_decoded, 1)

    def test_advance_skips_whole_blocks(self):
        reader = self.plist.reader()
        self.assertEqual(reader.advance(18), 19)  # 跳过 [2,5,7] [11,13,17]
        self.assertEqual(reader.blocks_decoded, 1)  # 只解码了含 19 的块
        self.assertEqual(reader.next(), 23)

    def test_advance_past_end(self):
        reader = self.plist.reader()
        self.assertIsNone(reader.advance(1000))
        self.assertTrue(reader.exhausted)
        self.assertIsNone(reader.next())

    def test_advance_interleaved_with_next(self):
        reader = self.plist.reader()
        got = []
        got.append(reader.next())        # 2
        got.append(reader.advance(11))   # 11
        got.append(reader.next())        # 13
        got.append(reader.advance(29))   # 29
        got.append(reader.next())        # 31
        got.append(reader.next())        # None
        self.assertEqual(got, [2, 11, 13, 29, 31, None])

    def test_blocks_decoded_counts_actual_decodes(self):
        reader = self.plist.reader()
        while reader.next() is not None:
            pass
        self.assertEqual(reader.blocks_decoded, 4)  # 10 条 / 块 3 = 4 块
        reader2 = self.plist.reader()
        reader2.advance(30)  # 跳过 3 块，只解码最后一块
        self.assertEqual(reader2.blocks_decoded, 1)


class SetOpsTest(unittest.TestCase):
    def test_empty_combinations(self):
        empty = PostingsList([])
        full = PostingsList([1, 2, 3])
        self.assertEqual(intersect(empty, full).to_list(), [])
        self.assertEqual(intersect(empty, empty).to_list(), [])
        self.assertEqual(union(empty, full).to_list(), [1, 2, 3])
        self.assertEqual(union(empty, empty).to_list(), [])
        self.assertEqual(difference(empty, full).to_list(), [])
        self.assertEqual(difference(full, empty).to_list(), [1, 2, 3])

    def test_known_results(self):
        a = PostingsList([1, 3, 5, 7, 9])
        b = PostingsList([3, 4, 5, 8])
        self.assertEqual(intersect(a, b).to_list(), [3, 5])
        self.assertEqual(union(a, b).to_list(), [1, 3, 4, 5, 7, 8, 9])
        self.assertEqual(difference(a, b).to_list(), [1, 7, 9])

    def test_against_python_sets_randomized(self):
        rng = random.Random(20260926)
        for _ in range(50):
            sa = set(rng.sample(range(200), rng.randint(0, 60)))
            sb = set(rng.sample(range(200), rng.randint(0, 60)))
            a = PostingsList(sorted(sa), block_size=rng.randint(1, 9))
            b = PostingsList(sorted(sb), block_size=rng.randint(1, 9))
            self.assertEqual(intersect(a, b).to_list(), sorted(sa & sb))
            self.assertEqual(union(a, b).to_list(), sorted(sa | sb))
            self.assertEqual(difference(a, b).to_list(), sorted(sa - sb))


class TokenizeTest(unittest.TestCase):
    def test_casefold_and_separators(self):
        self.assertEqual(tokenize("Hello, WORLD! foo_bar 42"),
                         ["hello", "world", "foo", "bar", "42"])

    def test_cjk_unigram_bigram(self):
        tokens = tokenize("苹果手机")
        for t in ("苹", "果", "手", "机", "苹果", "果手", "手机"):
            self.assertIn(t, tokens)

    def test_mixed_text(self):
        tokens = tokenize("iPhone17 发布了")
        self.assertIn("iphone17", tokens)
        self.assertIn("发布", tokens)


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.index = InvertedIndex(block_size=2)
        for doc in ("苹果手机新品", "香蕉和苹果", "手机芯片"):
            self.index.add_document(doc)
        self.index.build()

    def test_boolean_queries(self):
        apple = self.index.postings("苹果")
        phone = self.index.postings("手机")
        self.assertEqual(apple.to_list(), [0, 1])
        self.assertEqual(self.index.and_(apple, phone).to_list(), [0])
        self.assertEqual(self.index.or_(apple, phone).to_list(), [0, 1, 2])
        self.assertEqual(self.index.not_(phone, apple).to_list(), [2])

    def test_missing_term_is_empty(self):
        self.assertEqual(self.index.postings("不存在词").to_list(), [])

    def test_long_cjk_term_bigram_fallback(self):
        # "手机芯片" 未直接索引，退化为 bigram 交集
        self.assertEqual(self.index.postings("手机芯片").to_list(), [2])


if __name__ == "__main__":
    unittest.main()
