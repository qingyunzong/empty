"""tokenizer 与 inverted_index 的单元测试（标准库 unittest）。"""

import unittest

from inverted_index import InvertedIndex
from tokenizer import tokenize

DOCS = [
    (1, "Apple banana apple pie"),
    (2, "Banana split with apple"),
    (3, "压缩 文档 ID 差分 列表"),
    (4, "Apple 压缩 列表 UTF-8 文本"),
    (5, "Cherry banana 压缩"),
]


class TestTokenizer(unittest.TestCase):
    def test_ascii_words_lowercased(self):
        self.assertEqual(tokenize("Hello, World!"), ["hello", "world"])

    def test_cjk_single_char_tokens(self):
        self.assertEqual(tokenize("压缩列表"), ["压", "缩", "列", "表"])

    def test_mixed_and_digits(self):
        self.assertEqual(
            tokenize("UTF-8 编码 v2.0"),
            ["utf", "8", "编", "码", "v2", "0"],
        )

    def test_punctuation_is_separator(self):
        self.assertEqual(tokenize("a+b=c"), ["a", "b", "c"])
        self.assertEqual(tokenize("。。。"), [])


class TestInvertedIndex(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = InvertedIndex(block_size=2)
        for doc_id, text in DOCS:
            cls.index.add_document(doc_id, text)
        cls.index.build()

    def test_and_query(self):
        self.assertEqual(self.index.query_and("apple", "banana"), [1, 2])
        self.assertEqual(self.index.query_and("压缩", "列表"), [3, 4])
        self.assertEqual(self.index.query_and("apple", "压缩"), [4])

    def test_or_query(self):
        self.assertEqual(self.index.query_or("cherry", "pie"), [1, 5])
        self.assertEqual(self.index.query_or("banana"), [1, 2, 5])

    def test_not_query(self):
        self.assertEqual(self.index.query_not("banana", "apple"), [5])
        self.assertEqual(self.index.query_not("压缩", "列表"), [5])

    def test_missing_term_behaves_as_empty(self):
        self.assertEqual(self.index.query_and("apple", "不存在"), [])
        self.assertEqual(self.index.query_or("不存在"), [])
        self.assertEqual(self.index.query_not("不存在", "apple"), [])
        self.assertEqual(self.index.query_not("apple", "不存在"), [1, 2, 4])

    def test_add_after_build_rejected(self):
        with self.assertRaises(RuntimeError):
            self.index.add_document(99, "too late")


if __name__ == "__main__":
    unittest.main()
