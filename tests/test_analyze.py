import unittest

from regexamb import (
    parse_pattern, collect_nodes, analyze, verify_parse,
    tree_from_json, Tree, Enumerator,
)

BIG = 5_000_000


def run(pattern, alphabet=None):
    root = parse_pattern(pattern)
    return root, analyze(root, alphabet=alphabet, budget=BIG)


class TestRequiredCases(unittest.TestCase):
    def test_union_of_same_literal(self):
        # a|a: two node choices for the same word
        root, res = run("a|a")
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "a")
        self.assertFalse(res["infinite"])
        nodes = collect_nodes(root)
        t1, t2 = (tree_from_json(p) for p in res["parses"])
        self.assertNotEqual(t1, t2)
        verify_parse(t1, nodes, "a")
        verify_parse(t2, nodes, "a")
        # the two parses differ in the selected alternative
        self.assertNotEqual(t1.children[0].node, t2.children[0].node)

    def test_nested_star_has_pumpable_epsilon_cycle(self):
        # (a*)*: the empty word has infinitely many parses
        root, res = run("(a*)*")
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "")
        self.assertTrue(res["infinite"])
        loop = res["epsilon_loop"]
        nodes = collect_nodes(root)
        base = tree_from_json(loop["base_parse"])
        pumped = tree_from_json(loop["pumped_parse"])
        verify_parse(base, nodes, "")
        verify_parse(pumped, nodes, "")
        self.assertNotEqual(base, pumped)
        # pumping adds exactly one empty repetition of the starred child
        star_id = loop["star_node"]
        self.assertEqual(nodes[star_id].kind, "star")
        self.assertEqual(loop["span"], [0, 0])

    def test_nullable_concatenation(self):
        # (a|ε)(ε|a): "a" splits as (a,ε) or (ε,a)
        root, res = run("(a|ε)(ε|a)")
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "a")
        nodes = collect_nodes(root)
        t1, t2 = (tree_from_json(p) for p in res["parses"])
        verify_parse(t1, nodes, "a")
        verify_parse(t2, nodes, "a")
        splits = sorted(t.children[0].end for t in (t1, t2))
        self.assertEqual(splits, [0, 1])  # different consumption intervals

    def test_same_parse_is_normalised(self):
        # a*: several derivations unroll the star differently but only one
        # parse tree exists per word; the analyser must not confuse
        # identical parses reached via different paths with ambiguity.
        root, res = run("a*")
        self.assertEqual(res["status"], "unambiguous")
        enum = Enumerator(root, budget=100000)
        for n in range(4):
            enum.compute_level(n)
        self.assertEqual(len(enum.levels[root.id][3]["aaa"]), 1)
        self.assertEqual(len(enum.levels[root.id][0][""]), 1)

    def test_empty_string_ambiguity(self):
        root, res = run("ε|ε")
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "")
        self.assertFalse(res["infinite"])

    def test_same_length_witnesses_pick_lexicographically_first(self):
        # both "aa" and "bb" are ambiguous; "aa" must be reported
        _, res = run("(a(a|a))|(b(b|b))", alphabet=["a", "b"])
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "aa")

    def test_unambiguous_long_prefix(self):
        _, res = run("abcdef(g|h)")
        self.assertEqual(res["status"], "unambiguous")
        cert = res["certificate"]
        self.assertEqual(cert["type"], "unambiguous")
        self.assertLessEqual(cert["max_epsilon_parses_per_node"], 1)
        self.assertFalse(cert["glushkov"]["divergent_accepting_pair"])

    def test_long_prefix_before_ambiguity(self):
        _, res = run("aaaa(a|a)")
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], "aaaaa")


class TestTamperedEvidence(unittest.TestCase):
    def _witness(self, pattern):
        root = parse_pattern(pattern)
        res = analyze(root, budget=BIG)
        self.assertEqual(res["status"], "ambiguous")
        return root, res

    def test_tampered_span_rejected(self):
        root, res = self._witness("(a|ab)(b|ε)")
        nodes = collect_nodes(root)
        word = res["word"]
        for raw in res["parses"]:
            tree = tree_from_json(raw)
            verify_parse(tree, nodes, word)
            stretched = Tree(tree.node, tree.start, tree.end + 1, tree.children)
            with self.assertRaises(Exception):
                verify_parse(stretched, nodes, word)

    def test_tampered_node_id_rejected(self):
        root, res = self._witness("(a|ab)(b|ε)")
        nodes = collect_nodes(root)
        word = res["word"]
        tree = tree_from_json(res["parses"][0])
        bogus = Tree(max(nodes) + 100, tree.start, tree.end, tree.children)
        with self.assertRaises(Exception):
            verify_parse(bogus, nodes, word)

    def test_parse_of_other_word_rejected(self):
        root, res = self._witness("(a|ab)(b|ε)")
        nodes = collect_nodes(root)
        tree = tree_from_json(res["parses"][0])
        with self.assertRaises(Exception):
            verify_parse(tree, nodes, "zz")

    def test_tampered_pump_evidence_rejected(self):
        root, res = self._witness("(a*)*")
        nodes = collect_nodes(root)
        loop = res["epsilon_loop"]
        unit = tree_from_json(loop["unit_epsilon_parse"])
        verify_parse(unit, nodes, "")  # sanity: genuine unit verifies
        # a pumped parse whose repetition does not match the starred child
        base = tree_from_json(loop["base_parse"])
        star_id = loop["star_node"]
        forged_children = base.children + (Tree(star_id, 0, 0),)
        forged = Tree(base.node, base.start, base.end, forged_children)
        with self.assertRaises(Exception):
            verify_parse(forged, nodes, "")


class TestCertificate(unittest.TestCase):
    def test_unambiguous_cases(self):
        for pattern in ["a*", "abc", "a(b|c)d", "(ab)*", "(a|b)*abb", "ba*(ε|b)"]:
            with self.subTest(pattern=pattern):
                _, res = run(pattern)
                self.assertEqual(res["status"], "unambiguous")
                self.assertIn("certificate", res)


if __name__ == "__main__":
    unittest.main()
