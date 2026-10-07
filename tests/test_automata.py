import unittest

from pathpolicy.automata import CharSet, NFA, compute_minterms
from pathpolicy.compiler import compile_pattern, legal_nfa
from pathpolicy.pattern import parse_pattern


class MintermTest(unittest.TestCase):
    def test_atoms(self):
        preds = [CharSet({"a"}), CharSet({"a", "b"}), CharSet({"/"}, negated=True)]
        minterms = compute_minterms(preds)
        finite = [m for m in minterms if not m.is_rest]
        rest = [m for m in minterms if m.is_rest]
        self.assertEqual(len(rest), 1)
        atoms = {frozenset(m.chars) for m in finite}
        self.assertEqual(atoms, {frozenset("a"), frozenset("b"), frozenset("/")})

    def test_rest_sample_avoids_excluded(self):
        preds = [CharSet(set("abc"))]
        (rest,) = [m for m in compute_minterms(preds) if m.is_rest]
        self.assertNotIn(rest.sample(), "abc")

    def test_samples_are_members(self):
        preds = [CharSet({"x", "y"}), CharSet({"y"}, negated=True)]
        for m in compute_minterms(preds):
            s = m.sample()
            for p in preds:
                sig_contains = p.contains(s)
                if not m.is_rest:
                    for c in m.chars:
                        self.assertEqual(p.contains(c), sig_contains)


class NfaTest(unittest.TestCase):
    def test_union_empty_is_empty_language(self):
        nfa = NFA.union([])
        self.assertFalse(nfa.accepts_string("/"))
        self.assertFalse(nfa.accepts_string("/a"))

    def test_compiled_pattern_accepts(self):
        nfa = compile_pattern(parse_pattern("a/**/b"))
        self.assertTrue(nfa.accepts_string("/a/b"))
        self.assertTrue(nfa.accepts_string("/a/x/y/b"))
        self.assertFalse(nfa.accepts_string("/a/b/c"))
        self.assertFalse(nfa.accepts_string("/ab"))

    def test_compiled_doublestar_root(self):
        nfa = compile_pattern(parse_pattern("**"))
        self.assertTrue(nfa.accepts_string("/"))
        self.assertTrue(nfa.accepts_string("/a/b"))

    def test_legal_language(self):
        nfa = legal_nfa()
        good = ["/", "/a", "/a/b", "/.a", "/a..b", "/x/y/z"]
        bad = ["", "//", "/a//b", "/a/", "/.", "/..", "/a/./b", "/a/../b", "a"]
        for p in good:
            self.assertTrue(nfa.accepts_string(p), p)
        for p in bad:
            self.assertFalse(nfa.accepts_string(p), p)

    def test_nfa_json_roundtrip(self):
        nfa = compile_pattern(parse_pattern("a/[bc]*/d?"))
        clone = NFA.from_json(nfa.to_json())
        self.assertEqual(clone.to_json(), nfa.to_json())
        for s in ("/a/b/d1", "/a/ccc/dd", "/a/b"):
            self.assertEqual(nfa.accepts_string(s), clone.accepts_string(s))


if __name__ == "__main__":
    unittest.main()
