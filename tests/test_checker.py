import copy
import unittest

from scheddiag.checker import (
    check_candidate,
    check_conflict_tree,
    check_evidence,
    check_schedule,
    parse_instance,
)
from scheddiag.cli import build_solver

UNSAT_DISJ = {
    "num_tasks": 2,
    "durations": [3, 3],
    "constraints": [
        {"u": "zero", "v": 0, "w": 1},
        {"u": 0, "v": "zero", "w": 0},
        {"u": "zero", "v": 1, "w": 1},
        {"u": 1, "v": "zero", "w": 0},
    ],
    "disjuncts": [[0, 1]],
}

SAT3 = {
    "num_tasks": 3,
    "durations": [2, 2, 2],
    "constraints": (
        [{"u": "zero", "v": i, "w": 4} for i in range(3)]
        + [{"u": i, "v": "zero", "w": 0} for i in range(3)]
    ),
    "disjuncts": [[0, 1], [1, 2], [0, 2]],
}


def unsat_tree():
    inst = parse_instance(UNSAT_DISJ)
    result = build_solver(inst).solve()
    assert result["status"] == "unsat"
    return inst, result["certificate"]["tree"]


class TestScheduleChecker(unittest.TestCase):
    def setUp(self):
        self.inst = parse_instance(SAT3)
        result = build_solver(self.inst).solve()
        assert result["status"] == "sat"
        self.schedule = result["schedule"]

    def test_valid_schedule_accepted(self):
        ok, reason = check_schedule(self.inst, self.schedule)
        self.assertTrue(ok, reason)

    def test_wrong_length_rejected(self):
        ok, _ = check_schedule(self.inst, self.schedule[:-1])
        self.assertFalse(ok)

    def test_non_integer_rejected(self):
        bad = list(self.schedule)
        bad[0] = 1.5
        self.assertFalse(check_schedule(self.inst, bad)[0])
        bad[0] = True
        self.assertFalse(check_schedule(self.inst, bad)[0])

    def test_overlapping_disjunct_rejected(self):
        bad = [0, 0, 4]  # tasks 0 and 1 overlap
        ok, reason = check_schedule(self.inst, bad)
        self.assertFalse(ok)
        self.assertIn("disjunct", reason)

    def test_static_constraint_violation_rejected(self):
        bad = [0, 2, 9]  # x_2 <= 4 violated
        self.assertFalse(check_schedule(self.inst, bad)[0])


class TestConflictTreeChecker(unittest.TestCase):
    def test_valid_tree_accepted(self):
        inst, tree = unsat_tree()
        ok, reason = check_conflict_tree(inst, tree)
        self.assertTrue(ok, reason)

    def test_tampered_weight_rejected(self):
        inst, tree = unsat_tree()
        tree["children"][0]["weight"] = -1
        ok, reason = check_conflict_tree(inst, tree)
        self.assertFalse(ok)
        self.assertIn("weight", reason)

    def test_positive_cycle_rejected(self):
        inst, tree = unsat_tree()
        leaf = tree["children"][0]
        # x_0 - x_zero <= 1 and x_zero - x_0 <= 0 form a cycle of weight 1
        leaf["cycle"] = [["static", 0], ["static", 1]]
        leaf["weight"] = 1
        ok, reason = check_conflict_tree(inst, tree)
        self.assertFalse(ok)
        self.assertIn("not negative", reason)

    def test_unknown_static_edge_rejected(self):
        inst, tree = unsat_tree()
        tree["children"][0]["cycle"][0] = ["static", 99]
        self.assertFalse(check_conflict_tree(inst, tree)[0])

    def test_decision_edge_off_path_rejected(self):
        inst, tree = unsat_tree()
        leaf = copy.deepcopy(tree["children"][0])
        self.assertIn(["decision", 0], leaf["cycle"])
        # the leaf is valid under the branch that decides disjunct 0
        self.assertTrue(check_conflict_tree(inst, tree)[0])
        # but the same leaf is invalid at the root, where nothing is decided
        ok, reason = check_conflict_tree(inst, leaf)
        self.assertFalse(ok)
        self.assertIn("not decided", reason)

    def test_missing_child_rejected(self):
        inst, tree = unsat_tree()
        del tree["children"][1]
        ok, reason = check_conflict_tree(inst, tree)
        self.assertFalse(ok)
        self.assertIn("two children", reason)

    def test_double_branch_same_disjunct_rejected(self):
        inst, tree = unsat_tree()
        nested = {"type": "branch", "disjunct": 0,
                  "children": [tree["children"][0], tree["children"][0]]}
        tree["children"][0] = nested
        ok, reason = check_conflict_tree(inst, tree)
        self.assertFalse(ok)
        self.assertIn("twice", reason)

    def test_broken_cycle_structure_rejected(self):
        inst, tree = unsat_tree()
        leaf = tree["children"][0]
        leaf["cycle"] = [["static", 0], ["static", 1]]  # not a cycle
        self.assertFalse(check_conflict_tree(inst, leaf)[0])

    def test_unknown_node_type_rejected(self):
        inst, _ = unsat_tree()
        self.assertFalse(check_conflict_tree(inst, {"type": "magic"})[0])


class TestCandidateChecker(unittest.TestCase):
    def test_valid_candidate_accept(self):
        inst = parse_instance(SAT3)
        ok, reason = check_candidate(inst, {
            "schedule": [0, 0, 0],
            "decisions": {},
            "undecided": [0, 1, 2],
        })
        self.assertTrue(ok, reason)

    def test_candidate_violating_static_rejected(self):
        inst = parse_instance(SAT3)
        ok, _ = check_candidate(inst, {"schedule": [0, 0, 9], "decisions": {}})
        self.assertFalse(ok)

    def test_candidate_violating_decision_rejected(self):
        inst = parse_instance(SAT3)
        ok, reason = check_candidate(inst, {
            "schedule": [0, 0, 4],
            "decisions": {"0": 0},  # claims task0 before task1 but both at 0
        })
        self.assertFalse(ok)
        self.assertIn("ordering", reason)


class TestEvidenceDispatch(unittest.TestCase):
    def test_unknown_status_dispatch(self):
        inst = parse_instance(SAT3)
        result = build_solver(inst).solve(branch_budget=0)
        self.assertEqual(result["status"], "unknown")
        ok, reason = check_evidence(inst, result)
        self.assertTrue(ok, reason)

    def test_bad_status_rejected(self):
        inst = parse_instance(SAT3)
        self.assertFalse(check_evidence(inst, {"status": "maybe"})[0])
        self.assertFalse(check_evidence(inst, "nonsense")[0])


if __name__ == "__main__":
    unittest.main()
