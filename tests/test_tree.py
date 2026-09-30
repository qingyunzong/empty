import unittest
from fractions import Fraction as F

from intervalmap import tree


def mk(pieces):
    return tree.build_from_sorted([(F(a), F(b), tuple(sorted(srcs.items())))
                                   for a, b, srcs in pieces])


class TestTree(unittest.TestCase):
    def setUp(self):
        # [0,5){a:1} [5,10){b:1} [20,30){a:2}
        self.root = mk([(0, 5, {"a": 1}), (5, 10, {"b": 1}), (20, 30, {"a": 2})])

    def test_inorder_sorted(self):
        segs = tree.inorder(self.root)
        self.assertEqual([n.start for n in segs], [F(0), F(5), F(20)])
        self.assertEqual(tree.total_length(self.root), F(20))

    def test_heap_property(self):
        def check(node):
            if node is None:
                return
            for child in (node.left, node.right):
                if child is not None:
                    self.assertGreater(node.prio, child.prio)
                check(child)
        check(self.root)

    def test_split_at_inside_segment(self):
        left, right = tree.split_at(self.root, F(7))
        self.assertEqual([(n.start, n.end) for n in tree.inorder(left)],
                         [(F(0), F(5)), (F(5), F(7))])
        self.assertEqual([(n.start, n.end) for n in tree.inorder(right)],
                         [(F(7), F(10)), (F(20), F(30))])
        # straddling segment split keeps identical sources on both halves
        self.assertEqual(tree.inorder(left)[-1].sources, tree.inorder(right)[0].sources)
        # original root untouched (persistence)
        self.assertEqual(len(tree.inorder(self.root)), 3)
        self.assertEqual(tree.total_length(left) + tree.total_length(right), F(20))

    def test_split_at_boundary_is_noop_split(self):
        left, right = tree.split_at(self.root, F(5))
        self.assertEqual(len(tree.inorder(left)), 1)
        self.assertEqual(len(tree.inorder(right)), 2)

    def test_split_at_infinity(self):
        left, right = tree.split_at(self.root, tree.NEG_INF)
        self.assertIsNone(left)
        self.assertEqual(len(tree.inorder(right)), 3)

    def test_merge_canonical_fuses_equal_sources(self):
        left = mk([(0, 5, {"a": 1})])
        right = mk([(5, 9, {"a": 1}), (9, 12, {"b": 1})])
        merged = tree.merge_canonical(left, right)
        segs = [(n.start, n.end, n.sources) for n in tree.inorder(merged)]
        self.assertEqual([(s, e) for s, e, _ in segs], [(F(0), F(9)), (F(9), F(12))])

    def test_merge_canonical_keeps_distinct_sources(self):
        left = mk([(0, 5, {"a": 1})])
        right = mk([(5, 9, {"b": 1})])
        merged = tree.merge_canonical(left, right)
        self.assertEqual(len(tree.inorder(merged)), 2)

    def test_find_containing(self):
        self.assertEqual(tree.find_containing(self.root, F(3)).start, F(0))
        self.assertIsNone(tree.find_containing(self.root, F(15)))
        self.assertEqual(tree.find_containing(self.root, F(5)).start, F(5))

    def test_aggregate_totals_with_infinity(self):
        inf_root = tree.build_from_sorted(
            [(tree.NEG_INF, F(0), (("a", 1),)), (F(0), F(4), (("b", 1),))])
        self.assertIs(tree.total_length(inf_root), tree.POS_INF)


if __name__ == "__main__":
    unittest.main()
