import unittest

from search_audit.tokenizer import tokenize


class TokenizerTest(unittest.TestCase):
    def test_latin_and_casefold(self):
        self.assertEqual(tokenize("Hello, WORLD!"), ["hello", "world"])

    def test_cjk_runs_are_single_tokens(self):
        self.assertEqual(tokenize("搜索 索引。"), ["搜索", "索引"])

    def test_mixed_text_and_separators(self):
        self.assertEqual(tokenize("UTF-8 编码，v2.0"),
                         ["utf", "8", "编码", "v2", "0"])

    def test_casefold_handles_unicode_expansion(self):
        self.assertEqual(tokenize("Straße"), ["strasse"])

    def test_empty_and_separators_only(self):
        self.assertEqual(tokenize(""), [])
        self.assertEqual(tokenize(" ，。\n！ "), [])

    def test_duplicates_are_kept_in_order(self):
        self.assertEqual(tokenize("a b a"), ["a", "b", "a"])


if __name__ == "__main__":
    unittest.main()
