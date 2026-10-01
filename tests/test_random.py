"""Cross-check the solver against independent brute-force enumeration."""

import itertools
import random
import unittest

from fdsolver import Searcher, all_solutions, build_solver, normalize_spec
from fdsolver import verify_unsat_certificate

VALUES = [1, 2, 3, 4]


def brute_force_solutions(spec):
    """Fully independent enumerator: raw product + explicit checks."""
    names = sorted(spec["variables"])
    domains = [spec["variables"][n] for n in names]
    out = []
    for combo in itertools.product(*domains):
        assignment = dict(zip(names, combo))
        ok = True
        for con in spec["constraints"]:
            if con["type"] == "allDifferent":
                picked = [assignment[v] for v in con["vars"]]
                if len(set(picked)) != len(picked):
                    ok = False
                    break
            else:
                row = [assignment[v] for v in con["vars"]]
                if row not in [list(t) for t in con["tuples"]]:
                    ok = False
                    break
        if ok:
            out.append(assignment)
    return out


def random_spec(rng):
    nvars = rng.randint(2, 6)
    variables = {}
    for i in range(nvars):
        size = rng.randint(1, 4)
        variables[f"x{i}"] = sorted(rng.sample(VALUES, size))
    constraints = []
    for _ in range(rng.randint(1, 4)):
        if rng.random() < 0.5:
            k = rng.randint(2, min(4, nvars))
            scope = rng.sample(sorted(variables), k)
            constraints.append({"type": "allDifferent", "vars": scope})
        else:
            k = rng.randint(2, min(3, nvars))
            scope = rng.sample(sorted(variables), k)
            tuples = []
            for combo in itertools.product(
                    *[variables[v] for v in scope]):
                if rng.random() < 0.5:
                    tuples.append(list(combo))
            constraints.append({"type": "table", "vars": scope,
                                "tuples": tuples})
    return {"variables": variables, "constraints": constraints}


class TestRandomNetworks(unittest.TestCase):
    def test_against_brute_force(self):
        rng = random.Random(20261001)
        unsat_checked = 0
        for trial in range(60):
            spec = normalize_spec(random_spec(rng))
            expected = brute_force_solutions(spec)
            got = all_solutions(spec)
            key = lambda a: tuple(a[n] for n in sorted(a))
            self.assertEqual(sorted(map(key, got)),
                             sorted(map(key, expected)),
                             f"solution set mismatch in trial {trial}")

            solver = build_solver(spec)
            if solver.conflict is not None:
                # propagation may only declare conflict when truly unsat
                self.assertEqual(expected, [],
                                 f"false conflict in trial {trial}")
            else:
                # every removed value must be absent from every real solution
                for var in spec["variables"]:
                    removed = set(spec["variables"][var]) - solver.domains[var]
                    for val in removed:
                        self.assertTrue(
                            all(sol[var] != val for sol in expected),
                            f"wrong removal {var}={val} in trial {trial}")
                # every kept value of every real solution must survive
                for sol in expected:
                    for var, val in sol.items():
                        self.assertIn(val, solver.domains[var])

            if not expected:
                sch = Searcher(spec)
                self.assertEqual(sch.run(), "unsat")
                self.assertTrue(verify_unsat_certificate(spec, sch.tree))
                # tampered certificate must fail verification
                if sch.tree == "conflict":
                    bad = {"var": "x0", "branches": []}
                else:
                    bad = {"var": sch.tree["var"],
                           "branches": sch.tree["branches"][:-1]}
                self.assertFalse(verify_unsat_certificate(spec, bad))
                unsat_checked += 1
            else:
                sch = Searcher(spec)
                self.assertEqual(sch.run(), "sat")
                self.assertIn(tuple(sch.witness[n] for n in sorted(sch.witness)),
                              set(map(key, expected)))
        self.assertGreater(unsat_checked, 5,
                           "random suite should exercise unsat certificates")


if __name__ == "__main__":
    unittest.main()
