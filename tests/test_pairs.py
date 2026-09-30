import unittest

from mealy_dist.pairs import PairAnalysis

from fixtures import (
    equivalent_machine,
    partial_no_experiment_machine,
    same_output_machine,
    three_state_machine,
)


class TestWitnesses(unittest.TestCase):
    def test_shortest_witnesses(self):
        analysis = PairAnalysis(three_state_machine())
        self.assertEqual(analysis.witness("q0", "q1"), ("b",))
        self.assertEqual(analysis.witness("q0", "q2"), ("a",))
        self.assertEqual(analysis.witness("q1", "q2"), ("a",))
        self.assertEqual(analysis.distance("q1", "q0"), 1)  # order-insensitive

    def test_same_output_names_do_not_distinguish(self):
        analysis = PairAnalysis(same_output_machine())
        # u and v emit identically named outputs on every input, so no
        # length-1 witness exists; the divergence shows up one step later.
        self.assertEqual(analysis.witness("u", "v"), ("a", "b"))
        self.assertEqual(analysis.witness("v", "w"), ("b",))
        self.assertEqual(analysis.distance("u", "v"), 2)

    def test_witness_actually_separates(self):
        machine = same_output_machine()
        analysis = PairAnalysis(machine)
        for a, b in analysis.distinguishable_pairs():
            witness = analysis.witness(a, b)
            self.assertNotEqual(machine.run(a, witness), machine.run(b, witness))


class TestIndistinguishable(unittest.TestCase):
    def test_equivalent_states(self):
        analysis = PairAnalysis(equivalent_machine())
        self.assertEqual(analysis.indistinguishable_pairs(), [("e0", "e1")])
        self.assertIn(["e0", "e1"], analysis.equivalence_classes())
        self.assertIsNone(analysis.witness("e0", "e1"))

    def test_partial_machine_all_pairs_distinguishable(self):
        analysis = PairAnalysis(partial_no_experiment_machine())
        self.assertEqual(analysis.indistinguishable_pairs(), [])
        self.assertEqual(len(analysis.distinguishable_pairs()), 6)

    def test_distinguishing_graph_edges(self):
        analysis = PairAnalysis(three_state_machine())
        graph = analysis.adjacency()
        # q0,q1 on input b move to q0,q1 (loop), on a to q1,q1 (no edge).
        edges = dict(graph[("q0", "q1")])
        self.assertIn("b", edges)
        self.assertEqual(edges["b"], ("q0", "q1"))


if __name__ == "__main__":
    unittest.main()
