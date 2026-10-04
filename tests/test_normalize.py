import unittest

from logfilter import Index, NormalizationRules, parse_pattern, search
from logfilter.normalize import UnknownNormalizationVersion


class TestNormalization(unittest.TestCase):
    def test_casefold_matching(self):
        idx = Index()  # nfc-casefold-v1
        idx.add_document("d1", "Hello WORLD")
        for pat in ("hello", "HELLO", "Hello"):
            result = search(idx, parse_pattern(pat))
            self.assertEqual([h["word"] for h in result["results"]], ["hello"])

    def test_unicode_codepoint_matching(self):
        idx = Index()
        idx.add_document("d1", "café naïve")
        result = search(idx, parse_pattern("café"))
        self.assertEqual([h["word"] for h in result["results"]], ["café"])
        # ? matches exactly one code point, not one byte
        result = search(idx, parse_pattern("caf?"))
        self.assertEqual([h["word"] for h in result["results"]], ["café"])
        result = search(idx, parse_pattern("caf??"))
        self.assertEqual(result["results"], [])

    def test_compatibility_normalization(self):
        idx = Index()
        idx.add_document("d1", "ﬁle")  # U+FB01 ligature fi
        result = search(idx, parse_pattern("file"))
        self.assertEqual([h["word"] for h in result["results"]], ["file"])

    def test_identity_rules_do_not_casefold(self):
        idx = Index(NormalizationRules("identity-v0"))
        idx.add_document("d1", "Hello")
        self.assertEqual(search(idx, parse_pattern("hello"))["results"], [])
        pattern = parse_pattern("Hello", NormalizationRules("identity-v0"))
        self.assertEqual(len(search(idx, pattern)["results"]), 1)

    def test_unknown_version_rejected(self):
        with self.assertRaises(UnknownNormalizationVersion):
            NormalizationRules("nope-v9").normalize("x")


if __name__ == "__main__":
    unittest.main()
