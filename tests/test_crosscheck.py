import random
import unittest

from schedsolve import Solver
from schedsolve.brute import brute_force, safe_horizon
from schedsolve.checker import verify_result


def gen_instance(rng):
    n = rng.randint(2, 4)
    durations = [rng.randint(1, 3) for _ in range(n)]
    constraints = []
    for _ in range(rng.randint(0, 4)):
        u, v = rng.randrange(n), rng.randrange(n)
        if u != v:
            constraints.append((u, v, rng.randint(-4, 6)))
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    rng.shuffle(pairs)
    disjuncts = pairs[:rng.randint(0, len(pairs))]
    return n, durations, constraints, disjuncts


class TestCrossCheck(unittest.TestCase):
    """Solver verdicts cross-checked against bounded integer enumeration."""

    def test_random_small_instances(self):
        rng = random.Random(20261001)
        tallies = {"sat": 0, "unsat": 0}
        for case in range(80):
            n, durations, constraints, disjuncts = gen_instance(rng)
            solver = Solver(n, durations)
            used = []
            for k, (u, v, c) in enumerate(constraints):
                cert = solver.add_constraint(u, v, c, uid=f"k{k}")
                used.append((u, v, c))
                if cert is not None:
                    break  # base level already inconsistent
            constraints = used
            for i, j in disjuncts:
                solver.add_disjunct(i, j)
            result = solver.solve()
            horizon = safe_horizon(durations, constraints)
            brute_status, _ = brute_force(n, durations, constraints,
                                          disjuncts, horizon)
            self.assertEqual(result.status, brute_status,
                             msg=f"case {case}: {(n, durations, constraints, disjuncts)}")
            tallies[result.status] += 1
            inst = {
                "n_tasks": n,
                "durations": durations,
                "constraints": [{"u": u, "v": v, "c": c, "uid": f"k{k}"}
                                for k, (u, v, c) in enumerate(constraints)],
                "disjuncts": [[i, j] for i, j in disjuncts],
            }
            # evidence (schedule or conflict tree) independently verifies
            self.assertTrue(verify_result(inst, result.to_json()),
                            msg=f"case {case}")
        # sanity: the random suite actually exercised both outcomes
        self.assertGreater(tallies["sat"], 0)
        self.assertGreater(tallies["unsat"], 0)

    def test_pause_resume_crosscheck(self):
        # verdict reached through many pause/resume cycles matches brute force
        rng = random.Random(7)
        for case in range(20):
            n, durations, constraints, disjuncts = gen_instance(rng)
            solver = Solver(n, durations)
            used = []
            for k, (u, v, c) in enumerate(constraints):
                cert = solver.add_constraint(u, v, c, uid=f"k{k}")
                used.append((u, v, c))
                if cert is not None:
                    break
            constraints = used
            for i, j in disjuncts:
                solver.add_disjunct(i, j)
            frontier = None
            result = None
            for _ in range(2000):
                result = solver.solve(relax_budget=n + 1, branch_budget=1,
                                      frontier=frontier)
                if result.status != "unknown":
                    break
                frontier = result.frontier
            else:
                self.fail(f"case {case}: search did not terminate")
            horizon = safe_horizon(durations, constraints)
            brute_status, _ = brute_force(n, durations, constraints,
                                          disjuncts, horizon)
            self.assertEqual(result.status, brute_status, msg=f"case {case}")


if __name__ == "__main__":
    unittest.main()
