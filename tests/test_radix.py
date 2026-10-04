import unittest

from logfilter.radix import RadixTree


def edge_labels(tree):
    def walk(node, out):
        for key in sorted(node.children):
            edge = node.children[key]
            out.append(edge.label)
            walk(edge.node, out)
    out = []
    walk(tree.root, out)
    return out


class TestRadixTree(unittest.TestCase):
    def test_add_and_contains(self):
        t = RadixTree()
        for w in ["foo", "food", "fool", "bar"]:
            self.assertTrue(t.add(w))
        self.assertFalse(t.add("foo"))  # duplicate
        for w in ["foo", "food", "fool", "bar"]:
            self.assertTrue(t.contains(w))
        for w in ["fo", "fools", "ba", "bard", ""]:
            self.assertFalse(t.contains(w))
        self.assertEqual(t.size, 4)

    def test_shared_prefix_compression(self):
        t = RadixTree()
        t.add("testing")
        t.add("tester")
        # shared prefix stored once: root edge "test", then "ing"/"er"
        self.assertIn("test", edge_labels(t))
        self.assertEqual(sorted(edge_labels(t)), ["er", "ing", "test"])

    def test_edge_split_on_insert(self):
        t = RadixTree()
        t.add("error")
        t.add("erroneous")
        labels = edge_labels(t)
        self.assertIn("erro", labels)   # split point
        self.assertIn("r", labels)      # remainder of "error"
        self.assertIn("neous", labels)  # new branch
        self.assertTrue(t.contains("error"))
        self.assertTrue(t.contains("erroneous"))

    def test_split_at_existing_word_boundary(self):
        t = RadixTree()
        t.add("err")
        t.add("error")
        self.assertTrue(t.contains("err"))
        self.assertTrue(t.contains("error"))
        t.add("er")
        self.assertEqual(list(t.words()), ["er", "err", "error"])

    def test_merge_on_delete(self):
        t = RadixTree()
        t.add("error")
        t.add("erroneous")
        self.assertIn("erro", edge_labels(t))
        t.remove("erroneous")
        # single-child chain collapses back to one compressed edge
        self.assertEqual(edge_labels(t), ["error"])
        self.assertTrue(t.contains("error"))
        self.assertFalse(t.contains("erroneous"))

    def test_delete_leaf_prunes_upward(self):
        t = RadixTree()
        t.add("abc")
        t.add("abd")
        t.remove("abd")
        self.assertEqual(edge_labels(t), ["abc"])
        t.remove("abc")
        self.assertEqual(edge_labels(t), [])
        self.assertEqual(t.size, 0)

    def test_remove_missing(self):
        t = RadixTree()
        t.add("abc")
        self.assertFalse(t.remove("ab"))
        self.assertFalse(t.remove("abcd"))
        self.assertFalse(t.remove("xyz"))
        self.assertEqual(t.size, 1)

    def test_locate_roundtrip(self):
        t = RadixTree()
        for w in ["error", "erroneous", "foo"]:
            t.add(w)
        # full word lands on a node
        self.assertIsNotNone(t.position_node(t.locate("error")))
        # mid-edge position resolves and advances correctly
        pos = t.locate("err")
        self.assertIsNone(t.position_node(pos))
        chars = [c for c, _ in t.advance(pos)]
        self.assertEqual(chars, ["o"])
        with self.assertRaises(KeyError):
            t.locate("xyz")

    def test_words_sorted(self):
        t = RadixTree()
        for w in ["banana", "band", "ban", "a", "bandana"]:
            t.add(w)
        self.assertEqual(list(t.words()), sorted(["banana", "band", "ban", "a", "bandana"]))


if __name__ == "__main__":
    unittest.main()
