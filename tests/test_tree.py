"""Tests for adaptive distinguishing tree synthesis."""
import itertools
import unittest

from mealy.preset import min_preset_sequence
from mealy.tree import Solver, tree_to_json
from mealy.verify import check_certificate

from machines import (
    ADAPTIVE_SET,
    SHARING_SET,
    adaptive_only_machine,
    cycle_machine,
    equivalent_machine,
    resume_machine,
    same_name_output_machine,
    sharing_machine,
    simple_machine,
)


def solve(machine, initials, **kwargs):
    return Solver(machine).solve(initials, **kwargs)


class TestAdaptiveTree(unittest.TestCase):
    def test_simple_machine_tree(self):
        machine = simple_machine()
        result = solve(machine, ["s1", "s2", "s3"])
        self.assertEqual(result["status"], "optimal")
        self.assertTrue(result["optimal"])
        self.assertEqual(result["depth"], 2)
        tree = tree_to_json(result["tree"])
        check = check_certificate(machine, tree, ["s1", "s2", "s3"])
        self.assertTrue(check["valid"], check["errors"])

    def test_pairwise_distinguishable_but_no_preset_sequence(self):
        machine = adaptive_only_machine()
        # No preset sequence of any length: after any two inputs some pair
        # of candidates occupies the very same state and can never be
        # separated again.
        for seq in itertools.product(machine.inputs, repeat=2):
            currents = {}
            for s in ADAPTIVE_SET:
                cur = s
                for inp in seq:
                    cur = machine.successor(cur, inp)
                currents[s] = cur
            values = list(currents.values())
            self.assertLess(
                len(set(values)), len(values),
                f"sequence {seq} keeps all candidates separated",
            )
        self.assertIsNone(min_preset_sequence(machine, ADAPTIVE_SET, max_len=4))
        # ... yet an adaptive distinguishing tree exists.
        result = solve(machine, ADAPTIVE_SET)
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["depth"], 2)

    def test_adaptive_branching_structure(self):
        machine = adaptive_only_machine()
        result = solve(machine, ADAPTIVE_SET)
        tree = tree_to_json(result["tree"])
        self.assertEqual(tree["type"], "node")
        self.assertEqual(tree["input"], "x")
        self.assertEqual(set(tree["children"]), {"0", "1"})
        # Different continuations per observed output: this is what makes
        # the strategy adaptive rather than a fixed sequence.
        branch0 = tree["children"]["0"]
        branch1 = tree["children"]["1"]
        self.assertEqual(branch0["input"], "a")
        self.assertEqual(branch1["input"], "b")
        self.assertEqual(branch0["children"]["0"], {"type": "leaf", "state": "A1"})
        self.assertEqual(branch0["children"]["1"], {"type": "leaf", "state": "A2"})
        self.assertEqual(branch1["children"]["0"], {"type": "leaf", "state": "B1"})
        self.assertEqual(branch1["children"]["1"], {"type": "leaf", "state": "B2"})
        check = check_certificate(machine, tree, ADAPTIVE_SET)
        self.assertTrue(check["valid"], check["errors"])
        self.assertEqual(check["stats"]["depth"], 2)

    def test_same_name_outputs_grouped_by_equality(self):
        machine = same_name_output_machine()
        result = solve(machine, ["N1", "N2", "N3"])
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["depth"], 2)
        tree = tree_to_json(result["tree"])
        self.assertEqual(tree["input"], "i")
        # N1 and N2 emit the same output name on input i and must stay
        # in one branch; N3 branches off.
        self.assertEqual(set(tree["children"]), {"ping", "pong"})
        self.assertEqual(tree["children"]["pong"], {"type": "leaf", "state": "N3"})
        sub = tree["children"]["ping"]
        self.assertEqual(sub["input"], "j")
        self.assertEqual(sub["children"]["ping"], {"type": "leaf", "state": "N1"})
        self.assertEqual(sub["children"]["pong"], {"type": "leaf", "state": "N2"})

    def test_tree_merging_shares_subproblems(self):
        machine = sharing_machine()
        result = solve(machine, SHARING_SET)
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["depth"], 2)
        # The identical sub-configuration {A,B}@(P,Q) is reached via both
        # root inputs x and y; it must be solved only once.
        self.assertGreater(result["stats"]["memo_hits"], 0)
        check = check_certificate(machine, tree_to_json(result["tree"]), SHARING_SET)
        self.assertTrue(check["valid"], check["errors"])

    def test_no_progress_cycle_is_cut(self):
        machine = cycle_machine()
        result = solve(machine, ["c1", "c2"])
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["depth"], 1)
        tree = tree_to_json(result["tree"])
        self.assertEqual(tree["input"], "y")

    def test_infeasible_set_reports_classes_and_evidence(self):
        machine = equivalent_machine()
        result = solve(machine, ["E1", "E2", "E3"])
        self.assertEqual(result["status"], "infeasible")
        self.assertFalse(result["optimal"])
        self.assertIsNone(result["tree"])
        self.assertIn(["E1", "E2"], result["equivalent_classes"])
        self.assertEqual(result["equivalent_pairs"], [["E1", "E2"]])
        self.assertIn(["E1", "E2", "E3"], result["undistinguishable_subsets"])
        self.assertTrue(result["evidence"])
        for entry in result["evidence"]:
            for info in entry["inputs"]:
                self.assertIn(info["reason"], ("merge", "unsolvable-successor"))
        # A distinguishable subset of the same machine still works.
        ok = solve(machine, ["E1", "E3"])
        self.assertEqual(ok["status"], "optimal")
        self.assertEqual(ok["depth"], 1)

    def test_pairwise_distinguishable_yet_no_tree(self):
        # All pairs are distinguishable, but every input merges some pair of
        # candidates, so no adaptive tree exists.  Non-existence must be
        # proved exactly, with closure evidence (not a greedy failure).
        from mealy.machine import MealyMachine

        machine = MealyMachine(
            states=["s0", "s1", "s2", "s3"],
            inputs=["i0", "i1"],
            transitions={
                "s0": {"i0": ["s0", "o0"], "i1": ["s0", "o0"]},
                "s1": {"i0": ["s0", "o0"], "i1": ["s3", "o1"]},
                "s2": {"i0": ["s3", "o0"], "i1": ["s1", "o1"]},
                "s3": {"i0": ["s0", "o1"], "i1": ["s1", "o1"]},
            },
        )
        from mealy.pairs import PairAnalysis

        analysis = PairAnalysis(machine)
        group = ["s0", "s1", "s2", "s3"]
        for i, s in enumerate(group):
            for t in group[i + 1:]:
                self.assertTrue(analysis.distinguishable(s, t))
        result = solve(machine, group)
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["equivalent_pairs"], [])
        self.assertIn(group, result["undistinguishable_subsets"])
        reasons = {
            info["reason"]
            for entry in result["evidence"]
            for info in entry["inputs"]
        }
        self.assertIn("merge", reasons)

    def test_single_state_set(self):
        machine = simple_machine()
        result = solve(machine, ["s2"])
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["depth"], 0)
        leaf = tree_to_json(result["tree"])
        self.assertEqual(leaf, {"type": "leaf", "state": "s2"})

    def test_resume_machine_optimal_depth(self):
        machine = resume_machine()
        result = solve(machine, ["r1", "r2", "r3"])
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["depth"], 2)


if __name__ == "__main__":
    unittest.main()
