import json
import unittest

from regex_ambiguity import Builder, analyze, verify_parse, Parse
from regex_ambiguity.parses import from_json as parse_from_json


def check_ambiguous(tc, root, word, infinite, max_steps=200000):
    res = analyze(root, max_steps=max_steps)
    tc.assertEqual(res["status"], "ambiguous", res)
    tc.assertEqual(res["word"], word, res)
    tc.assertEqual(res["infinite"], infinite, res)
    tc.assertEqual(len(res["parses"]), 2)
    trees = [parse_from_json(p) for p in res["parses"]]
    tc.assertNotEqual(trees[0], trees[1])
    for t in trees:
        ok, err = verify_parse(root, res["word"], t)
        tc.assertTrue(ok, err)
    if infinite:
        tc.assertIsNotNone(res["pump"])
    json.dumps(res)  # result must be JSON-serialisable
    return res


class AnalyzerTest(unittest.TestCase):
    def test_union_same_literal(self):
        # a|a
        b = Builder()
        root = b.union(b.lit("a"), b.lit("a"))
        res = check_ambiguous(self, root, "a", False)
        branch_ids = {p["children"][0]["node"] for p in res["parses"]}
        self.assertEqual(len(branch_ids), 2)

    def test_nested_star_pumpable(self):
        # (a*)* : infinitely many parses of the empty word
        b = Builder()
        inner = b.star(b.lit("a"))
        root = b.star(inner)
        res = check_ambiguous(self, root, "", True)
        self.assertEqual(res["pump"]["star_id"], root.id)

    def test_nullable_concat(self):
        # (a*)(a*) : "a" splits two ways
        b = Builder()
        s1, s2 = b.star(b.lit("a")), b.star(b.lit("a"))
        root = b.cat(s1, s2)
        res = check_ambiguous(self, root, "a", False)
        splits = set()
        for p in res["parses"]:
            c1, c2 = p["children"]
            splits.add((tuple(c1["span"]), tuple(c2["span"])))
        self.assertEqual(splits, {((0, 1), (1, 1)), ((0, 0), (0, 1))})

    def test_empty_string_ambiguity(self):
        # eps | a* : two parses of ""
        b = Builder()
        root = b.union(b.eps(), b.star(b.lit("a")))
        check_ambiguous(self, root, "", False)

    def test_same_length_witnesses_lexicographic(self):
        # (ba|ba)|(aa|aa) : both "aa" and "ba" ambiguous, expect "aa"
        b = Builder()
        root = b.union(
            b.union(b.cat(b.lit("b"), b.lit("a")), b.cat(b.lit("b"), b.lit("a"))),
            b.union(b.cat(b.lit("a"), b.lit("a")), b.cat(b.lit("a"), b.lit("a"))))
        check_ambiguous(self, root, "aa", False)

    def test_unambiguous_long_prefix(self):
        # aaaa b | aaaa c : long shared prefix, still unambiguous
        b = Builder()
        root = b.union(
            b.cat(b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("b")),
            b.cat(b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("c")))
        res = analyze(root)
        self.assertEqual(res["status"], "unambiguous", res)
        self.assertIn("certificate", res)
        self.assertGreater(res["certificate"]["product_states_explored"], 0)

    def test_long_prefix_then_ambiguity(self):
        # aaaaa (b|b) : ambiguity only after a long prefix
        b = Builder()
        root = b.cat(b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"),
                     b.union(b.lit("b"), b.lit("b")))
        check_ambiguous(self, root, "aaaaab", False)

    def test_star_of_nullable_union_pumpable(self):
        # (eps|b)*
        b = Builder()
        root = b.star(b.union(b.eps(), b.lit("b")))
        res = check_ambiguous(self, root, "", True)
        self.assertEqual(res["pump"]["star_id"], root.id)

    def test_star_of_epsilon_pumpable(self):
        # (eps)*
        b = Builder()
        root = b.star(b.eps())
        check_ambiguous(self, root, "", True)

    def test_unambiguous_cat_star(self):
        # a* b
        b = Builder()
        root = b.cat(b.star(b.lit("a")), b.lit("b"))
        res = analyze(root)
        self.assertEqual(res["status"], "unambiguous", res)

    def test_same_parse_normalisation(self):
        # Structurally identical parse trees built separately must compare
        # (and hash) equal: parse identity is (node id, span, children),
        # never the automaton path that produced them.
        t1 = Parse(1, 0, 1, (Parse(2, 0, 1, ()),))
        t2 = Parse(1, 0, 1, (Parse(2, 0, 1, ()),))
        self.assertEqual(t1, t2)
        self.assertEqual(hash(t1), hash(t2))
        self.assertEqual(len({t1, t2}), 1)
        # a*a has looping automaton paths but exactly one parse per word
        b = Builder()
        root = b.cat(b.star(b.lit("a")), b.lit("a"))
        res = analyze(root)
        self.assertEqual(res["status"], "unambiguous", res)

    def test_budget_exhaustion_and_resume(self):
        b = Builder()
        root = b.cat(b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"),
                     b.union(b.lit("b"), b.lit("b")))
        one_shot = analyze(root, max_steps=1000000)
        self.assertEqual(one_shot["status"], "ambiguous")

        res0 = analyze(root, max_steps=0)
        self.assertEqual(res0["status"], "unknown")
        self.assertEqual(res0["reason"], "step_budget_exhausted")
        # resume state must survive a JSON round trip
        resume = json.loads(json.dumps(res0["resume"]))
        res1 = analyze(root, max_steps=3, resume=resume)
        self.assertEqual(res1["status"], "unknown")
        res2 = analyze(root, max_steps=1000000,
                       resume=json.loads(json.dumps(res1["resume"])))
        self.assertEqual(res2["status"], "ambiguous")
        self.assertEqual(res2["word"], one_shot["word"])
        self.assertEqual(res2["parses"], one_shot["parses"])

    def test_word_length_budget_and_resume(self):
        b = Builder()
        root = b.cat(b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"), b.lit("a"),
                     b.union(b.lit("b"), b.lit("b")))
        res0 = analyze(root, max_word_len=3)
        self.assertEqual(res0["status"], "unknown")
        self.assertEqual(res0["reason"], "word_length_budget_exhausted")
        res1 = analyze(root, resume=json.loads(json.dumps(res0["resume"])))
        self.assertEqual(res1["status"], "ambiguous")
        self.assertEqual(res1["word"], "aaaaab")

    def test_pump_evidence_parses_verify(self):
        # pumpable evidence parses must pass the independent verifier
        b = Builder()
        root = b.star(b.star(b.lit("a")))
        res = analyze(root)
        self.assertEqual(res["status"], "ambiguous")
        self.assertTrue(res["infinite"])
        for p in res["parses"]:
            ok, err = verify_parse(root, res["word"], parse_from_json(p))
            self.assertTrue(ok, err)


if __name__ == "__main__":
    unittest.main()
