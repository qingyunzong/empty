"""Cross-validation of the automaton engine against an independent
dynamic-programming edit-distance computation and a plain recursive
wildcard interpreter, over exhaustive short-alphabet dictionaries."""

import itertools
import random
import unittest

from logfilter import Index, min_edits, parse_pattern, search, wildcard_match

ALPHABET = "ab"
MAX_LEN = 5


def all_words():
    words = []
    for length in range(1, MAX_LEN + 1):
        for tup in itertools.product(ALPHABET, repeat=length):
            words.append("".join(tup))
    return words


WORDS = all_words()  # 62 words over {a,b} of length 1..5

PATTERNS = [
    "a", "b", "ab", "ba", "aab",
    "*", "a*", "*b", "a*b", "*a*", "b*a*b",
    "?", "??", "a?", "?b", "a?b?", "?*?",
    "[ab]", "[ab]b", "a[ab]", "[!a]b", "[a-b][!b]",
    "a~1", "ab~1", "aab~1", "bab~2", "ab~2", "a~2",
    "a?~1", "?b~2", "[ab]a~1", "a*b~1", "*a~2", "a*b*~2",
    "[!a]~1", "??~2", "b[ab]*~1",
]


def build_index():
    idx = Index()
    # spread words over several docs; some words share a doc
    for i, word in enumerate(WORDS):
        idx.add_document(f"doc{i % 7}", word)
    idx.add_document("combo", "ab ba ab")
    return idx


class TestEngineVersusBruteForce(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idx = build_index()

    def test_words_and_edit_costs_match_dp(self):
        for pat in PATTERNS:
            pattern = parse_pattern(pat)
            result = search(self.idx, pattern)
            self.assertTrue(result["complete"], msg=pat)
            engine = {h["word"]: h["edits"] for h in result["results"]}
            expected = {}
            for word in self.idx.postings:
                d = min_edits(pattern.tokens, word)
                if d <= pattern.edits:
                    expected[word] = d
            self.assertEqual(engine, expected, msg=pat)

    def test_docs_attached_to_hits(self):
        for pat in PATTERNS:
            pattern = parse_pattern(pat)
            for hit in search(self.idx, pattern)["results"]:
                self.assertEqual(
                    hit["docs"], sorted(self.idx.postings_for(hit["word"])),
                    msg=(pat, hit["word"]),
                )

    def test_alignment_cost_matches_dp(self):
        for pat in PATTERNS:
            pattern = parse_pattern(pat)
            for hit in search(self.idx, pattern)["results"]:
                self.assertEqual(
                    hit["alignment"]["edits"],
                    min_edits(pattern.tokens, hit["word"]),
                    msg=(pat, hit["word"]),
                )

    def test_zero_edit_consistency_with_wildcard_interpreter(self):
        for pat in PATTERNS:
            pattern = parse_pattern(pat)
            for word in WORDS:
                self.assertEqual(
                    wildcard_match(pattern.tokens, word),
                    min_edits(pattern.tokens, word) == 0,
                    msg=(pat, word),
                )

    def test_star_matches_empty(self):
        pattern = parse_pattern("ab*")
        engine = {h["word"] for h in search(self.idx, pattern)["results"]}
        self.assertIn("ab", engine)  # star consumed the empty string
        self.assertTrue(wildcard_match(pattern.tokens, "ab"))
        self.assertEqual(min_edits(pattern.tokens, "ab"), 0)

    def test_random_patterns(self):
        rng = random.Random(20261004)
        pieces = ["a", "b", "?", "*", "[ab]", "[!a]", "[a-b]", "c"]
        for _ in range(60):
            body = "".join(rng.choice(pieces) for _ in range(rng.randint(1, 5)))
            pat = body + rng.choice(["", "~1", "~2"])
            pattern = parse_pattern(pat)
            engine = {h["word"]: h["edits"] for h in search(self.idx, pattern)["results"]}
            expected = {}
            for word in self.idx.postings:
                d = min_edits(pattern.tokens, word)
                if d <= pattern.edits:
                    expected[word] = d
            self.assertEqual(engine, expected, msg=pat)


if __name__ == "__main__":
    unittest.main()
