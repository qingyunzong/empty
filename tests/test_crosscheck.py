"""Cross-check the analyser against an independent bounded enumerator.

The brute-force enumerator below is written independently of the library
internals: it recursively enumerates every parse tree of a concrete word
(capping star repetitions so that epsilon cycles stay finite) and scans
all words up to length 6 in lexicographic order.
"""
import unittest
from itertools import product

from regexamb import parse_pattern, collect_nodes, analyze, verify_parse, tree_from_json

ALPHABET = ("a", "b")
MAXLEN = 6
BIG = 20_000_000


def brute_trees(node, word, i, j, max_reps):
    """All parse trees of ``node`` for ``word[i:j]`` as nested tuples."""
    kind = node.kind
    if kind == "lit":
        ok = j == i + 1 and word[i] == node.char
        return [(node.id, i, j, ())] if ok else []
    if kind == "eps":
        return [(node.id, i, j, ())] if i == j else []
    if kind == "alt":
        out = []
        for child in node.children:
            for t in brute_trees(child, word, i, j, max_reps):
                out.append((node.id, i, j, (t,)))
        return out
    if kind == "cat":
        out = []
        for m in range(i, j + 1):
            for a in brute_trees(node.children[0], word, i, m, max_reps):
                for b in brute_trees(node.children[1], word, m, j, max_reps):
                    out.append((node.id, i, j, (a, b)))
        return out
    # star: sequences of 0..max_reps repetitions (cap keeps eps cycles finite)
    out = []
    if i == j:
        out.append((node.id, i, j, ()))
    child = node.children[0]

    def extend(pos, acc, reps_left):
        if pos == j and acc:
            out.append((node.id, i, j, acc))
        if reps_left == 0:
            return
        for m in range(pos, j + 1):
            for t in brute_trees(child, word, pos, m, max_reps):
                extend(m, acc + (t,), reps_left - 1)

    extend(i, (), max_reps)
    return out


def brute_first_ambiguous(root, maxlen=MAXLEN):
    for n in range(maxlen + 1):
        for chars in product(ALPHABET, repeat=n):
            word = "".join(chars)
            trees = set(brute_trees(root, word, 0, n, n + 2))
            if len(trees) >= 2:
                return word
    return None


AMBIGUOUS_PATTERNS = [
    "a|a",
    "(a*)*",
    "(a|ε)(ε|a)",
    "ε|ε",
    "(a(a|a))|(b(b|b))",
    "aaaa(a|a)",
    "(a|ab)(b|ε)",
    "a*(a|a)",
    "(a|b)(a|b)|ab",
    "(ε|a)(ε|a)",
]

UNAMBIGUOUS_PATTERNS = [
    "a*",
    "abc",
    "a(b|c)d",
    "abcdef(g|h)",
    "(ab)*",
    "(a|b)*abb",
    "ba*(ε|b)",
    "a(b|ε)c",
]


class TestCrossCheck(unittest.TestCase):
    def test_ambiguous_patterns_match_brute_force(self):
        for pattern in AMBIGUOUS_PATTERNS:
            with self.subTest(pattern=pattern):
                root = parse_pattern(pattern)
                expected = brute_first_ambiguous(root)
                self.assertIsNotNone(expected, "brute force found no witness")
                res = analyze(root, alphabet=ALPHABET, budget=BIG)
                self.assertEqual(res["status"], "ambiguous")
                self.assertEqual(res["word"], expected)
                nodes = collect_nodes(root)
                trees = [tree_from_json(p) for p in res["parses"]]
                self.assertEqual(len(trees), 2)
                self.assertNotEqual(trees[0], trees[1])
                for t in trees:
                    verify_parse(t, nodes, expected)

    def test_unambiguous_patterns_match_brute_force(self):
        for pattern in UNAMBIGUOUS_PATTERNS:
            with self.subTest(pattern=pattern):
                root = parse_pattern(pattern)
                self.assertIsNone(brute_first_ambiguous(root),
                                  "brute force found a witness")
                res = analyze(root, alphabet=ALPHABET, budget=BIG)
                self.assertEqual(res["status"], "unambiguous")
                self.assertIn("certificate", res)

    def test_infinite_flag_matches_brute_force(self):
        # (a*)* and (ε|a)(ε|a)... check which witnesses have eps cycles
        root = parse_pattern("(a*)*")
        res = analyze(root, alphabet=ALPHABET, budget=BIG)
        self.assertTrue(res["infinite"])
        # brute force sees >= 3 trees for "" (0, 1, 2 empty reps)
        trees = set(brute_trees(root, "", 0, 0, 3))
        self.assertGreaterEqual(len(trees), 3)


if __name__ == "__main__":
    unittest.main()
