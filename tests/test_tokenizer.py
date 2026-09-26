import unittest

from src.tokenizer import tokenize


class TokenizeTest(unittest.TestCase):
    def test_basic_words_are_casefolded(self):
        self.assertEqual(tokenize("Hello, WORLD!"), ["hello", "world"])

    def test_letters_and_digits_stay_together(self):
        self.assertEqual(tokenize("OAuth2 abc123"), ["oauth2", "abc123"])

    def test_underscore_is_a_separator(self):
        self.assertEqual(tokenize("foo_bar"), ["foo", "bar"])

    def test_nfkc_folds_fullwidth_forms(self):
        self.assertEqual(tokenize("Ｆｕｌｌｗｉｄｔｈ １２３"), ["fullwidth", "123"])

    def test_han_ideographs_become_unigrams(self):
        self.assertEqual(tokenize("中文分词"), ["中", "文", "分", "词"])

    def test_mixed_script_run(self):
        self.assertEqual(tokenize("hello世界"), ["hello", "世", "界"])

    def test_accented_letters_are_word_chars(self):
        self.assertEqual(tokenize("café naïve"), ["café", "naïve"])

    def test_empty_and_punctuation_only(self):
        self.assertEqual(tokenize(""), [])
        self.assertEqual(tokenize("！!。 …"), [])


if __name__ == "__main__":
    unittest.main()
