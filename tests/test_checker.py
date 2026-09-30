import copy
import unittest

from schedsolve import Solver
from schedsolve.checker import (
    CheckFailure,
    check,
    validate_instance,
    verify_candidate,
    verify_conflict_tree,
    verify_schedule,
)

INST = {
    "n_tasks": 2,
    "durations": [2, 3],
    "constraints": [{"u": 0, "v": 1, "c": 0}, {"u": 1, "v": 0, "c": 0}],
    "disjuncts": [[0, 1]],
}


def unsat_tree():
    solver = Solver(2, [2, 3])
    solver.add_constraint(0, 1, 0)
    solver.add_constraint(1, 0, 0)
    solver.add_disjunct(0, 1)
    result = solver.solve()
    assert result.status == "unsat"
    return result.conflict_tree


class TestSatEvidence(unittest.TestCase):
    def test_valid_schedule_accepted(self):
        inst = {"n_tasks": 2, "durations": [2, 3],
                "constraints": [{"u": 0, "v": 1, "c": 4}], "disjuncts": [[0, 1]]}
        self.assertTrue(verify_schedule(inst, {"0": 0, "1": 2}))

    def test_overlapping_schedule_rejected(self):
        inst = {"n_tasks": 2, "durations": [2, 3], "disjuncts": [[0, 1]]}
        with self.assertRaises(CheckFailure):
            verify_schedule(inst, {"0": 0, "1": 1})  # intervals overlap

    def test_constraint_violation_rejected(self):
        inst = {"n_tasks": 2, "durations": [1, 1],
                "constraints": [{"u": 0, "v": 1, "c": 2}]}
        with self.assertRaises(CheckFailure):
            verify_schedule(inst, {"0": 0, "1": 5})

    def test_missing_task_rejected(self):
        inst = {"n_tasks": 2, "durations": [1, 1]}
        with self.assertRaises(CheckFailure):
            verify_schedule(inst, {"0": 0})

    def test_non_integer_start_rejected(self):
        inst = {"n_tasks": 1, "durations": [1]}
        with self.assertRaises(CheckFailure):
            verify_schedule(inst, {"0": 1.5})


class TestUnsatEvidence(unittest.TestCase):
    def test_valid_tree_accepted(self):
        self.assertTrue(verify_conflict_tree(INST, unsat_tree()))

    def test_disconnected_cycle_rejected(self):
        tree = unsat_tree()
        leaf = tree["children"]["0"]["cycle"]
        leaf["edges"] = [leaf["edges"][0], copy.deepcopy(leaf["edges"][0])]
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(INST, tree)

    def test_nonnegative_cycle_rejected(self):
        # edges form a genuine cycle but its weight is not negative
        inst = {"n_tasks": 2, "durations": [1, 1],
                "constraints": [{"u": 0, "v": 1, "c": 3},
                                {"u": 1, "v": 0, "c": 1}]}
        tree = {"type": "leaf", "cycle": {
            "type": "negative_cycle",
            "edges": [{"uid": "k0", "u": 0, "v": 1, "c": 3},
                      {"uid": "k1", "u": 1, "v": 0, "c": 1}],
            "weight": 4}}
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(inst, tree)

    def test_unknown_uid_rejected(self):
        tree = unsat_tree()
        tree["children"]["0"]["cycle"]["edges"][0]["uid"] = "nope"
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(INST, tree)

    def test_edge_uid_mismatch_rejected(self):
        tree = unsat_tree()
        tree["children"]["0"]["cycle"]["edges"][0]["c"] += 1  # lies about k0
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(INST, tree)

    def test_weight_field_mismatch_rejected(self):
        tree = unsat_tree()
        tree["children"]["0"]["cycle"]["weight"] -= 1
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(INST, tree)

    def test_incomplete_tree_rejected(self):
        tree = unsat_tree()
        del tree["children"]["1"]  # only one ordering refuted: proves nothing
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(INST, tree)

    def test_branch_on_non_disjunct_rejected(self):
        tree = unsat_tree()
        tree["pair"] = [0, 0]
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(INST, tree)

    def test_decision_from_wrong_path_rejected(self):
        # leaf cites the ordering decision of the *other* branch
        tree = unsat_tree()
        left = tree["children"]["0"]["cycle"]
        right = tree["children"]["1"]["cycle"]
        left["edges"], right["edges"] = right["edges"], left["edges"]
        left["weight"], right["weight"] = right["weight"], left["weight"]
        with self.assertRaises(CheckFailure):
            verify_conflict_tree(INST, tree)


class TestUnknownEvidence(unittest.TestCase):
    def _unknown(self):
        solver = Solver(3, [2, 2, 1])
        solver.add_disjunct(0, 1)
        solver.add_disjunct(1, 2)
        solver.add_disjunct(0, 2)
        return solver.solve(branch_budget=1)

    def test_valid_unknown_accepted(self):
        result = self._unknown()
        self.assertEqual(result.status, "unknown")
        inst = {"n_tasks": 3, "durations": [2, 2, 1],
                "disjuncts": [[0, 1], [1, 2], [0, 2]]}
        self.assertTrue(verify_candidate(inst, result.candidate, result.frontier))

    def test_candidate_violating_chosen_order_rejected(self):
        result = self._unknown()
        inst = {"n_tasks": 3, "durations": [2, 2, 1],
                "disjuncts": [[0, 1], [1, 2], [0, 2]]}
        bad = dict(result.candidate)
        bad["1"] = bad["0"]  # task 1 starts when task 0 does: order violated
        with self.assertRaises(CheckFailure):
            verify_candidate(inst, bad, result.frontier)

    def test_bad_frontier_rejected(self):
        result = self._unknown()
        inst = {"n_tasks": 3, "durations": [2, 2, 1],
                "disjuncts": [[0, 1], [1, 2], [0, 2]]}
        frontier = {"choices": [{"index": 9, "pair": [0, 1], "chosen": 0,
                                 "remaining": [], "subtrees": {}}]}
        with self.assertRaises(CheckFailure):
            verify_candidate(inst, result.candidate, frontier)


class TestInstanceValidation(unittest.TestCase):
    def test_bad_instances_rejected(self):
        bad = [
            {"n_tasks": 0, "durations": []},
            {"n_tasks": 2, "durations": [1, 0]},          # non-positive duration
            {"n_tasks": 2, "durations": [1]},             # wrong length
            {"n_tasks": 2, "durations": [1, 1],
             "constraints": [{"u": 0, "v": 2, "c": 0}]},  # index out of range
            {"n_tasks": 2, "durations": [1, 1],
             "constraints": [{"u": 0, "v": 1, "c": 1.5}]},  # non-integer bound
            {"n_tasks": 2, "durations": [1, 1],
             "disjuncts": [[0, 0]]},                      # self disjunct
            {"n_tasks": 2, "durations": [1, 1],
             "disjuncts": [[0, 1], [1, 0]]},              # duplicate disjunct
        ]
        for inst in bad:
            with self.assertRaises(CheckFailure, msg=str(inst)):
                validate_instance(inst)

    def test_check_wrapper(self):
        ok, reason = check(INST, {"status": "unsat",
                                  "conflict_tree": unsat_tree()})
        self.assertTrue(ok)
        self.assertIsNone(reason)
        ok, reason = check(INST, {"status": "sat", "schedule": {"0": 0, "1": 0}})
        self.assertFalse(ok)
        self.assertIsInstance(reason, str)


if __name__ == "__main__":
    unittest.main()
