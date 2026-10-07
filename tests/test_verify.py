import copy
import random
import unittest

from ghtree import CutTree

from util import assert_tree_correct, random_graph


def _tampered_tree(seed=2024, n=6):
    rng = random.Random(seed)
    tree = CutTree(random_graph(rng, n))
    assert tree.edges, "need a non-empty tree for tampering tests"
    return tree


class VerifyTests(unittest.TestCase):
    def test_clean_tree_passes(self):
        tree = _tampered_tree()
        self.assertEqual(tree.verify(), [])

    def test_tampered_flow_amount_detected(self):
        tree = _tampered_tree()
        state = tree.to_state()
        # Inflate the first flow entry of the first edge that carries flow.
        for edge in state["tree"]:
            if edge["flow"]:
                edge["flow"][0][2] += 1
                break
        else:
            self.skipTest("no flow to tamper with")
        twin = CutTree.from_state(state)
        errors = twin.verify()
        self.assertTrue(any("flow" in e for e in errors), errors)

    def test_dropped_flow_arc_detected(self):
        tree = _tampered_tree()
        state = tree.to_state()
        for edge in state["tree"]:
            if edge["flow"]:
                edge["flow"].pop()
                break
        else:
            self.skipTest("no flow to tamper with")
        twin = CutTree.from_state(state)
        self.assertTrue(twin.verify())

    def test_tampered_cut_side_detected(self):
        tree = _tampered_tree()
        state = tree.to_state()
        edge = state["tree"][0]
        # Replace the recorded side with a different canonical one.
        edge["cut_side"] = [0] if edge["cut_side"] != [0] else [0, 1]
        twin = CutTree.from_state(state)
        self.assertTrue(twin.verify())

    def test_tampered_value_detected(self):
        tree = _tampered_tree()
        state = tree.to_state()
        state["tree"][0]["value"] += 1
        twin = CutTree.from_state(state)
        self.assertTrue(twin.verify())

    def test_tampered_capacity_detected(self):
        tree = _tampered_tree()
        state = tree.to_state()
        # Silently change the graph without re-certifying the tree.
        state["capacities"][0][2] += 3
        twin = CutTree.from_state(state)
        self.assertTrue(twin.verify())

    def test_verify_after_updates(self):
        rng = random.Random(31337)
        tree = CutTree(random_graph(rng, 8))
        for _ in range(5):
            updates = []
            for _ in range(3):
                u, v = rng.randrange(8), rng.randrange(8)
                if u != v:
                    updates.append((u, v, rng.randint(0, 9)))
            tree.update(updates)
            self.assertEqual(tree.verify(), [])
        assert_tree_correct(self, tree)


if __name__ == "__main__":
    unittest.main()
