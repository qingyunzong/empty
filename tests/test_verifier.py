import unittest

from regexamb import (
    parse_pattern, collect_nodes, verify_parse, VerifyError, Tree,
)


def make_tree():
    # pattern "ab": cat(lit a #0, lit b #1) as node #2
    root = parse_pattern("ab")
    nodes = collect_nodes(root)
    tree = Tree(root.id, 0, 2, (Tree(0, 0, 1), Tree(1, 1, 2)))
    return root, nodes, tree


class TestVerifier(unittest.TestCase):
    def test_valid_tree_accepted(self):
        _, nodes, tree = make_tree()
        verify_parse(tree, nodes, "ab")

    def test_root_span_must_cover_word(self):
        _, nodes, tree = make_tree()
        bad = Tree(tree.node, 0, 1, tree.children)
        with self.assertRaises(VerifyError):
            verify_parse(bad, nodes, "ab")

    def test_wrong_literal_rejected(self):
        _, nodes, tree = make_tree()
        with self.assertRaises(VerifyError):
            verify_parse(tree, nodes, "ac")

    def test_unknown_node_rejected(self):
        _, nodes, tree = make_tree()
        bad = Tree(99, 0, 2, tree.children)
        with self.assertRaises(VerifyError):
            verify_parse(bad, nodes, "ab")

    def test_non_contiguous_cat_rejected(self):
        _, nodes, tree = make_tree()
        bad = Tree(tree.node, 0, 2, (Tree(0, 0, 1), Tree(1, 0, 1)))
        with self.assertRaises(VerifyError):
            verify_parse(bad, nodes, "ab")

    def test_swapped_children_rejected(self):
        _, nodes, tree = make_tree()
        bad = Tree(tree.node, 0, 2, (Tree(1, 0, 1), Tree(0, 1, 2)))
        with self.assertRaises(VerifyError):
            verify_parse(bad, nodes, "ab")

    def test_eps_interval_enforced(self):
        root = parse_pattern("εa")
        nodes = collect_nodes(root)
        eps_id = root.children[0].id
        lit_id = root.children[1].id
        good = Tree(root.id, 0, 1, (Tree(eps_id, 0, 0), Tree(lit_id, 0, 1)))
        verify_parse(good, nodes, "a")
        bad = Tree(root.id, 0, 1, (Tree(eps_id, 0, 1), Tree(lit_id, 1, 1)))
        with self.assertRaises(VerifyError):
            verify_parse(bad, nodes, "a")

    def test_star_repetition_rules(self):
        root = parse_pattern("a*")
        nodes = collect_nodes(root)
        lit_id = root.children[0].id
        good = Tree(root.id, 0, 2, (Tree(lit_id, 0, 1), Tree(lit_id, 1, 2)))
        verify_parse(good, nodes, "aa")
        gap = Tree(root.id, 0, 2, (Tree(lit_id, 0, 1), Tree(lit_id, 0, 1)))
        with self.assertRaises(VerifyError):
            verify_parse(gap, nodes, "aa")
        wrong_child = Tree(root.id, 0, 1, (Tree(root.id, 0, 1),))
        with self.assertRaises(VerifyError):
            verify_parse(wrong_child, nodes, "a")

    def test_alt_choice_enforced(self):
        root = parse_pattern("a|b")
        nodes = collect_nodes(root)
        left, right = root.children
        good = Tree(root.id, 0, 1, (Tree(left.id, 0, 1),))
        verify_parse(good, nodes, "a")
        # right alternative cannot parse "a"
        with self.assertRaises(VerifyError):
            verify_parse(Tree(root.id, 0, 1, (Tree(right.id, 0, 1),)), nodes, "a")
        # alt must not invent children
        foreign = Tree(root.id, 0, 1, (Tree(root.id, 0, 1),))
        with self.assertRaises(VerifyError):
            verify_parse(foreign, nodes, "a")


if __name__ == "__main__":
    unittest.main()
