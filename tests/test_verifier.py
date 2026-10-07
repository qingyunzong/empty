import unittest
from dataclasses import replace

from regex_ambiguity import Builder, analyze, verify_parse, Parse
from regex_ambiguity.parses import from_json as parse_from_json


def valid_parse_of_a_union_a():
    b = Builder()
    l1, l2 = b.lit("a"), b.lit("a")
    root = b.union(l1, l2)
    res = analyze(root)
    tree = parse_from_json(res["parses"][0])
    return root, l1, l2, tree


class VerifierTest(unittest.TestCase):
    def test_valid_parse_accepted(self):
        root, _, _, tree = valid_parse_of_a_union_a()
        ok, err = verify_parse(root, "a", tree)
        self.assertTrue(ok, err)

    def test_tampered_span_rejected(self):
        root, _, _, tree = valid_parse_of_a_union_a()
        bad = replace(tree, end=2)
        ok, _ = verify_parse(root, "a", bad)
        self.assertFalse(ok)
        bad = replace(tree, start=1, end=1)
        ok, _ = verify_parse(root, "a", bad)
        self.assertFalse(ok)

    def test_tampered_node_id_rejected(self):
        root, l1, l2, tree = valid_parse_of_a_union_a()
        # leaf claims the id of the union node
        bad = replace(tree, children=(replace(tree.children[0], node_id=root.id),))
        ok, _ = verify_parse(root, "a", bad)
        self.assertFalse(ok)
        # unknown node id
        bad = replace(tree, children=(replace(tree.children[0], node_id=999),))
        ok, _ = verify_parse(root, "a", bad)
        self.assertFalse(ok)

    def test_tampered_children_rejected(self):
        root, l1, l2, tree = valid_parse_of_a_union_a()
        leaf = tree.children[0]
        # union with no child
        ok, _ = verify_parse(root, "a", replace(tree, children=()))
        self.assertFalse(ok)
        # union with two children
        ok, _ = verify_parse(root, "a", replace(tree, children=(leaf, leaf)))
        self.assertFalse(ok)
        # literal with a child
        bad_leaf = replace(leaf, children=(Parse(l1.id, 0, 1, ()),))
        ok, _ = verify_parse(root, "a", replace(tree, children=(bad_leaf,)))
        self.assertFalse(ok)

    def test_tampered_literal_char_rejected(self):
        root, _, _, tree = valid_parse_of_a_union_a()
        ok, _ = verify_parse(root, "b", tree)
        self.assertFalse(ok)

    def test_tampered_star_split_rejected(self):
        # (a*)(a*) on "a": moving the split point without updating both
        # children must be rejected
        b = Builder()
        s1, s2 = b.star(b.lit("a")), b.star(b.lit("a"))
        root = b.cat(s1, s2)
        res = analyze(root)
        tree = parse_from_json(res["parses"][0])
        ok, err = verify_parse(root, "a", tree)
        self.assertTrue(ok, err)
        c1, c2 = tree.children
        bad = replace(tree, children=(replace(c1, end=1 - c1.end), c2))
        ok, _ = verify_parse(root, "a", bad)
        self.assertFalse(ok)
        # children swapped out of order
        bad = replace(tree, children=(c2, c1))
        ok, _ = verify_parse(root, "a", bad)
        self.assertFalse(ok)

    def test_tampered_pump_evidence_rejected(self):
        b = Builder()
        root = b.star(b.star(b.lit("a")))
        res = analyze(root)
        tree = parse_from_json(res["parses"][1])  # one epsilon iteration
        ok, err = verify_parse(root, "", tree)
        self.assertTrue(ok, err)
        # claim the iteration consumed a character
        inner = tree.children[0]
        bad = replace(tree, end=1, children=(replace(inner, end=1),))
        ok, _ = verify_parse(root, "", bad)
        self.assertFalse(ok)

    def test_non_parse_object_rejected(self):
        root, _, _, _ = valid_parse_of_a_union_a()
        ok, _ = verify_parse(root, "a", "not a parse")
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
