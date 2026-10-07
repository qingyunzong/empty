import unittest

from logfilter import (
    CURRENT_NORMALIZATION_VERSION,
    Index,
    NormalizationVersionError,
    normalize,
    search,
)


class TestNormalization(unittest.TestCase):
    def test_version_is_fixed_and_named(self):
        self.assertEqual(CURRENT_NORMALIZATION_VERSION, "nfc-casefold-v1")

    def test_casefold(self):
        self.assertEqual(normalize("HeLLo"), "hello")

    def test_nfc_composes_accents(self):
        decomposed = "cafe\u0301"  # e + combining acute
        composed = "caf\u00e9"
        self.assertNotEqual(decomposed, composed)
        self.assertEqual(normalize(decomposed), normalize(composed))

    def test_unknown_version_rejected(self):
        with self.assertRaises(ValueError):
            normalize("x", version="nfc-casefold-v0")

    def test_matching_uses_normalization(self):
        index = Index()
        index.add_document("d1", ["Café"])
        for pattern in ("café", "CAFÉ", "café"):
            with self.subTest(pattern=pattern):
                result = search(index, pattern=pattern, limit=10)
                self.assertEqual([e["doc_id"] for e in result.results], ["d1"])

    def test_normalization_version_change_is_detected(self):
        index = Index()
        index.add_document("d1", ["abc"])
        # simulate an index built with older/different rules
        index.normalization_version = "nfc-casefold-v0"
        with self.assertRaises(NormalizationVersionError):
            search(index, pattern="abc")

    def test_roundtrip_preserves_version(self):
        index = Index()
        index.add_document("d1", ["abc"])
        clone = Index.from_dict(index.to_dict())
        self.assertEqual(clone.normalization_version, CURRENT_NORMALIZATION_VERSION)


if __name__ == "__main__":
    unittest.main()
