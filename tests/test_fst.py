import unittest

from logfilter import Automaton, Index


class TestAutomaton(unittest.TestCase):
    def test_shared_prefixes_and_suffixes_are_merged(self):
        # trie nodes: root,a,b,c,d,x,b,c = 8; after minimization the three
        # terminal leaves merge into one node -> 6 nodes total.
        aut = Automaton(["abc", "abd", "xbc"])
        self.assertEqual(aut.node_count, 6)
        for word in ("abc", "abd", "xbc"):
            self.assertTrue(aut.accepts(word))
        for word in ("", "ab", "xbd", "abcx", "bc"):
            self.assertFalse(aut.accepts(word))

    def test_empty_automaton(self):
        aut = Automaton([])
        self.assertEqual(aut.node_count, 1)
        self.assertFalse(aut.accepts(""))

    def test_walk(self):
        aut = Automaton(["abc", "abd"])
        self.assertIsNotNone(aut.walk("ab"))
        self.assertIsNone(aut.walk("ax"))
        self.assertIs(aut.walk(""), aut.start)


class TestNodeSplitMergeThroughIndex(unittest.TestCase):
    def test_nodes_split_and_merge_with_terms(self):
        index = Index()
        index.add_document("doc1", ["abc", "abd", "xbc"])
        self.assertEqual(index.automaton.node_count, 6)

        # adding "xbd" makes the suffixes from "a" and "x" identical, so
        # the "b" nodes (and then the "a"/"x" nodes) merge: 6 -> 4 nodes.
        index.add_document("doc2", ["xbd"])
        self.assertEqual(index.automaton.node_count, 4)
        self.assertTrue(index.automaton.accepts("xbd"))

        # deleting the last reference to "xbd" splits the nodes again.
        self.assertTrue(index.delete_document("doc2"))
        self.assertEqual(index.automaton.node_count, 6)
        self.assertFalse(index.automaton.accepts("xbd"))

        # removing every term collapses the automaton back to the start node.
        self.assertTrue(index.delete_document("doc1"))
        self.assertEqual(index.automaton.node_count, 1)
        self.assertEqual(index.num_terms, 0)


if __name__ == "__main__":
    unittest.main()
