"""Acceptance E: randomized differential testing.

Generates n = 1000 small random specs and compares cegen against an
independent reference solver that brute-forces the whole space with
itertools.product and picks the minimum by (cost, canonical index tuple).
Status and counterexample minimality must agree exactly.
"""
import builtins
import itertools
import random
import unittest

from cegen import COUNTEREXAMPLE, INVALID_INPUT, PROOF, find

SAFE = {name: getattr(builtins, name)
        for name in ("abs", "all", "any", "len", "max", "min", "sorted", "sum")}

SEED = 20260930
NUM_SPECS = 1000


# ---------- independent reference implementation ----------

def ref_domain(vspec, bound, max_len):
    kind = vspec["type"]
    if kind == "int":
        values = sorted(range(-bound, bound + 1), key=lambda v: (abs(v), v))
        return values, [abs(v) for v in values]
    if kind == "bool":
        return [False, True], [0, 1]
    if kind == "list":
        elem_values, elem_costs = ref_domain(
            vspec.get("elem", {"type": "int"}), bound, max_len)
        limit = vspec.get("max_len", max_len)
        combos = []
        for length in range(limit + 1):
            for idxs in itertools.product(range(len(elem_values)), repeat=length):
                combos.append(idxs)
        combos.sort(key=lambda idxs: (len(idxs) + sum(elem_costs[i] for i in idxs),
                                      idxs))
        values = [tuple(elem_values[i] for i in idxs) for idxs in combos]
        costs = [len(idxs) + sum(elem_costs[i] for i in idxs) for idxs in combos]
        return values, costs
    raise AssertionError(kind)


def to_lists(value):
    if isinstance(value, tuple):
        return [to_lists(v) for v in value]
    return value


def ref_solve(spec, bound, max_len):
    """Brute-force every assignment; decide by (cost, index-tuple) order."""
    domains = [ref_domain(v, bound, max_len) for v in spec["variables"]]
    names = [v["name"] for v in spec["variables"]]
    best_ce = best_key = exc_key = None
    enumerated = 0
    for combo in itertools.product(*(range(len(d[0])) for d in domains)):
        enumerated += 1
        key = (sum(d[1][i] for d, i in zip(domains, combo)), combo)
        env = {n: to_lists(d[0][i]) for n, d, i in zip(names, domains, combo)}
        try:
            holds = bool(eval(spec["predicate"], {"__builtins__": {}},
                              {**SAFE, **env}))
        except Exception:
            if exc_key is None or key < exc_key:
                exc_key = key
            continue
        if not holds and (best_key is None or key < best_key):
            best_key = key
            best_ce = {n: to_lists(d[0][i])
                       for n, d, i in zip(names, domains, combo)}
    if best_ce is not None and (exc_key is None or best_key < exc_key):
        return COUNTEREXAMPLE, best_ce, enumerated
    if exc_key is not None:
        return INVALID_INPUT, None, enumerated
    if best_ce is not None:
        return COUNTEREXAMPLE, best_ce, enumerated
    return PROOF, None, enumerated


# ---------- random spec generation ----------

def gen_predicate(rng, variables):
    ints = [v["name"] for v in variables if v["type"] == "int"]
    bools = [v["name"] for v in variables if v["type"] == "bool"]
    lists = [v["name"] for v in variables if v["type"] == "list"]

    def pick(pool):
        return rng.choice(pool) if pool else None

    templates = []

    if ints:
        templates += [
            lambda: f"{pick(ints)} + {pick(ints)} <= {rng.randint(-2, 3)}",
            lambda: f"{pick(ints)} * {pick(ints)} >= {rng.randint(-1, 2)}",
            lambda: f"abs({pick(ints)}) <= {rng.randint(0, 2)}",
            lambda: f"10 % ({pick(ints)} + {rng.randint(0, 1)}) == 0",
            lambda: f"{pick(ints)} != {rng.randint(-2, 2)}",
        ]
    if bools:
        templates += [
            lambda: f"{pick(bools)} or {rng.choice(['True', 'False'])}",
            lambda: f"not {pick(bools)}",
        ]
    if lists:
        templates += [
            lambda: f"len({pick(lists)}) <= {rng.randint(0, 2)}",
            lambda: f"sum({pick(lists)}) >= {rng.randint(-2, 2)}",
            lambda: f"{pick(lists)} == sorted({pick(lists)})",
            lambda: f"all(e < {rng.randint(0, 2)} for e in {pick(lists)})",
            lambda: f"{pick(lists)}[0] >= 0",
        ]
    if ints and bools:
        templates.append(lambda: f"({pick(ints)} > 0) == {pick(bools)}")
    if ints and lists:
        templates.append(lambda: f"{pick(ints)} + {pick(lists)}")
    templates += [lambda: "True", lambda: "False", lambda: "missing > 0"]

    return rng.choice(templates)()


def gen_spec(rng):
    variables = []
    for i in range(rng.randint(1, 3)):
        kind = rng.choice(["int", "bool", "list"])
        var = {"name": f"v{i}", "type": kind}
        if kind == "list":
            var["elem"] = {"type": rng.choice(["int", "bool"])}
            var["max_len"] = rng.randint(0, 2)
        variables.append(var)
    return {
        "variables": variables,
        "predicate": gen_predicate(rng, variables),
        "bound": rng.randint(1, 2),
    }


class RandomizedDifferential(unittest.TestCase):
    def test_matches_itertools_reference(self):
        rng = random.Random(SEED)
        tallies = {}
        for i in range(NUM_SPECS):
            spec = gen_spec(rng)
            bound = spec["bound"]
            max_len = 2
            with self.subTest(case=i, spec=spec):
                expected_status, expected_ce, expected_enum = ref_solve(
                    spec, bound, max_len)
                result = find(spec, max_len=max_len)
                self.assertEqual(result["status"], expected_status)
                if expected_status == COUNTEREXAMPLE:
                    self.assertEqual(result["counterexample"], expected_ce)
                else:
                    self.assertIsNone(result["counterexample"])
                if expected_status == PROOF:
                    self.assertEqual(result["stats"]["enumerated"],
                                     expected_enum)
                    self.assertIn("closure_hash", result["stats"])
            tallies[expected_status] = tallies.get(expected_status, 0) + 1
        # sanity: the random suite must exercise every status
        for status in (COUNTEREXAMPLE, PROOF, INVALID_INPUT):
            self.assertIn(status, tallies)


if __name__ == "__main__":
    unittest.main()
