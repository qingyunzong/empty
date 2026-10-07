import random
import unittest

from scheddiag.brute import brute_force, time_bound
from scheddiag.checker import check_evidence, parse_instance
from scheddiag.cli import build_solver

from tests.test_solver import BIG_UNSAT, SAT3, UNSAT_DIFF, UNSAT_DISJ


def cross_check(inst_dict):
    inst = parse_instance(inst_dict)
    result = build_solver(inst).solve()
    expected, witness = brute_force(inst)
    return inst, result, expected, witness


class TestFixedInstances(unittest.TestCase):
    def test_fixed_instances_match_brute_force(self):
        for inst in (SAT3, UNSAT_DISJ, UNSAT_DIFF, BIG_UNSAT):
            parsed, result, expected, _ = cross_check(inst)
            self.assertEqual(result["status"], expected, inst)
            ok, reason = check_evidence(parsed, result)
            self.assertTrue(ok, reason)

    def test_difference_feasible_disjunctively_unsat_crosscheck(self):
        # the solver must not conclude sat from difference-local consistency
        parsed, result, expected, _ = cross_check(UNSAT_DISJ)
        self.assertEqual(expected, "unsat")
        self.assertEqual(result["status"], "unsat")


class TestRandomCrossCheck(unittest.TestCase):
    def test_random_small_instances(self):
        rng = random.Random(20261007)
        checked = {"sat": 0, "unsat": 0}
        for _ in range(80):
            n = rng.randint(1, 4)
            durations = [rng.randint(1, 2) for _ in range(n)]
            constraints = []
            for _ in range(rng.randint(0, 5)):
                u = rng.randint(0, n)
                v = rng.randint(0, n)
                w = rng.randint(-3, 3)
                constraints.append({
                    "u": u if u < n else "zero",
                    "v": v if v < n else "zero",
                    "w": w,
                })
            pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
            rng.shuffle(pairs)
            disjuncts = [list(p) for p in pairs[:rng.randint(0, 3)]]
            inst_dict = {"num_tasks": n, "durations": durations,
                         "constraints": constraints, "disjuncts": disjuncts}
            inst = parse_instance(inst_dict)
            bound = time_bound(inst)
            if (2 * bound + 1) ** n > 2_000_000:
                continue
            result = build_solver(inst).solve()
            expected, witness = brute_force(inst)
            self.assertEqual(result["status"], expected, inst_dict)
            ok, reason = check_evidence(inst, result)
            self.assertTrue(ok, f"{reason} for {inst_dict}")
            checked[expected] += 1
        self.assertGreater(checked["sat"], 10)
        self.assertGreater(checked["unsat"], 10)


if __name__ == "__main__":
    unittest.main()
