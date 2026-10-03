"""Randomised cross-validation against independent brute-force enumeration.

For random networks of at most 6 variables with domain size at most 4:
  * the solver's solution set must equal brute-force enumeration;
  * every value removed by root propagation must be absent from every
    brute-force solution (no valid value is ever pruned);
  * UNSAT certificates must verify, and tampered ones must fail.
"""

import copy
import itertools
import random
import unittest

from fdsolver import (
    Searcher,
    Solver,
    check_witness,
    enumerate_solutions,
    solve,
    verify_unsat,
)

SEED = 20261004
INSTANCES = 60


def brute_force(spec):
    names = sorted(spec["variables"])
    domains = [spec["variables"][n] for n in names]
    constraints = spec["constraints"]
    solutions = []
    for combo in itertools.product(*domains):
        assignment = dict(zip(names, combo))
        ok = True
        for c in constraints:
            if c["type"] == "table":
                row = [assignment[n] for n in c["scope"]]
                if row not in [list(t) for t in c["tuples"]]:
                    ok = False
                    break
            elif c["type"] == "alldifferent":
                values = [assignment[n] for n in c["scope"]]
                if len(set(values)) != len(values):
                    ok = False
                    break
        if ok:
            solutions.append(assignment)
    return solutions


def random_spec(rng):
    n_vars = rng.randint(2, 6)
    names = [f"v{i}" for i in range(n_vars)]
    variables = {}
    for name in names:
        size = rng.randint(1, 4)
        variables[name] = sorted(rng.sample([1, 2, 3, 4], size))
    constraints = []
    for _ in range(rng.randint(1, n_vars)):
        if rng.random() < 0.5:
            arity = rng.randint(2, min(3, n_vars))
            scope = rng.sample(names, arity)
            rows = list(itertools.product(*[variables[v] for v in scope]))
            keep = [list(r) for r in rows if rng.random() < 0.6]
            constraints.append({"type": "table", "scope": scope, "tuples": keep})
        else:
            size = rng.randint(2, n_vars)
            scope = rng.sample(names, size)
            constraints.append({"type": "alldifferent", "scope": scope})
    return {"variables": variables, "constraints": constraints}


def tamper(certificate, rng):
    cert = copy.deepcopy(certificate)
    choice = rng.randrange(4)

    def nodes(node):
        yield node
        if isinstance(node, dict) and "children" in node:
            for child in node["children"].values():
                yield from nodes(child)

    all_nodes = list(nodes(cert))
    target = rng.choice(all_nodes)
    if choice == 0:
        if "children" in target and target["children"]:
            key = rng.choice(list(target["children"]))
            del target["children"][key]      # drop a branch
        else:
            target["conflict"] = False       # corrupt a leaf flag
    elif choice == 1:
        if "children" in target:
            target["var"] = "forged"         # unknown variable
        else:
            target["conflict"] = False
    elif choice == 2:
        if "children" in target and target["children"]:
            key = rng.choice(list(target["children"]))
            target["children"][key] = {"conflict": False}  # fake leaf flag
        else:
            target["conflict"] = False
    else:
        # replace the whole tree by a bare leaf (invalid unless the root
        # really is a conflict, in which case flip its flag instead)
        cert = {"conflict": False} if cert == {"conflict": True} \
            else {"conflict": True}
    return cert


class RandomCrossCheckTest(unittest.TestCase):
    def test_random_networks_against_brute_force(self):
        rng = random.Random(SEED)
        n_sat = n_unsat = 0
        for i in range(INSTANCES):
            spec = random_spec(rng)
            with self.subTest(instance=i):
                expected = brute_force(spec)
                expected_keys = {
                    tuple(sorted(sol.items())) for sol in expected}

                # 1. full solution set must match brute force
                found = enumerate_solutions(spec)
                found_keys = {tuple(sorted(sol.items())) for sol in found}
                self.assertEqual(found_keys, expected_keys)

                # 2. every value pruned at the root is in no brute-force solution
                solver = Solver.from_spec(spec)
                consistent = solver.propagate()
                if consistent:
                    for name, dom in solver.domains.items():
                        for value in set(spec["variables"][name]) - dom:
                            self.assertFalse(
                                any(sol[name] == value for sol in expected),
                                f"{name}={value} wrongly pruned in {spec}")

                # 3. search verdict, witness and certificate
                result = solve(spec)
                if expected:
                    n_sat += 1
                    self.assertEqual(result["status"], "sat")
                    self.assertTrue(check_witness(spec, result["witness"]))
                    self.assertIn(
                        tuple(sorted(result["witness"].items())), expected_keys)
                else:
                    n_unsat += 1
                    self.assertEqual(result["status"], "unsat")
                    cert = result["certificate"]
                    self.assertTrue(verify_unsat(spec, cert))
                    for _ in range(3):
                        self.assertFalse(
                            verify_unsat(spec, tamper(cert, rng)))
        # sanity: the suite must exercise both outcomes
        self.assertGreater(n_sat, 0)
        self.assertGreater(n_unsat, 0)

    def test_incremental_search_matches_continuous_on_random_specs(self):
        rng = random.Random(SEED + 1)
        for i in range(12):
            spec = random_spec(rng)
            with self.subTest(instance=i):
                continuous = Searcher(spec).run()
                state = None
                while True:
                    searcher = (Searcher(spec) if state is None
                                else Searcher.from_state(spec, state))
                    result = searcher.run(budget=searcher.nodes + 1)
                    if result["status"] == "unknown":
                        state = result["state"]
                        continue
                    break
                self.assertEqual(result["status"], continuous["status"])
                self.assertEqual(result["witness"], continuous["witness"])
                self.assertEqual(
                    result["certificate"], continuous["certificate"])


if __name__ == "__main__":
    unittest.main()
