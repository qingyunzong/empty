"""Acceptance E: cegen vs an independent itertools brute-force reference.

1000 seeded random small specs are searched by both implementations and the
results must agree on status, the enumerated prefix, and minimality of the
returned counterexample. The reference implementation is written from
scratch using only itertools and eval; it never calls into cegen.
"""
from __future__ import annotations

import itertools
import random
import unittest

from cegen import (
    COUNTEREXAMPLE,
    INVALID_INPUT,
    PROOF,
    UNKNOWN,
    parse_spec,
    search,
)

NUM_SPECS = 1000
SEED = 20260929
DEFAULT_BOUND = 3
MAX_SPACE = 4000
COMPARISONS = ["<", "<=", ">", ">=", "==", "!="]
BINARY = ["+", "-", "*"]
NAME_POOL = ["x", "y", "z", "w", "u", "v", "p", "q"]

SAFE_FUNCS = {
    "abs": abs,
    "all": all,
    "any": any,
    "len": len,
    "max": max,
    "min": min,
    "sum": sum,
}


# --------------------------------------------------------------------------
# Random spec generation
# --------------------------------------------------------------------------

def gen_domain(rng, depth=0):
    roll = rng.random()
    if roll < 0.45 or depth >= 1:
        return {"type": "int", "bound": rng.randint(0, 2)}
    if roll < 0.7:
        return {"type": "bool"}
    elem_kind = "bool" if rng.random() < 0.4 else "int"
    elem = (
        {"type": "bool"}
        if elem_kind == "bool"
        else {"type": "int", "bound": rng.randint(0, 1)}
    )
    return {"type": "list", "max_len": rng.randint(0, 2), "elem": elem}


def space_size(domain):
    if domain["type"] == "int":
        return 2 * domain.get("bound", DEFAULT_BOUND) + 1
    if domain["type"] == "bool":
        return 2
    n = space_size(domain["elem"])
    return sum(n ** length for length in range(domain["max_len"] + 1))


def gen_arith(rng, int_names, list_names, depth):
    atoms = [str(rng.randint(0, 2))]
    if int_names:
        atoms.append(rng.choice(int_names))
    if list_names:
        atoms.append(f"len({rng.choice(list_names)})")
        int_lists = list_names  # elements may be int or bool; sum always works
        if int_lists and rng.random() < 0.5:
            atoms.append(f"sum({rng.choice(int_lists)})")
    if depth <= 0 or rng.random() < 0.35:
        return rng.choice(atoms)
    op = rng.choice(BINARY)
    return "(" + gen_arith(rng, int_names, list_names, depth - 1) + op + \
        gen_arith(rng, int_names, list_names, depth - 1) + ")"


def gen_bool(rng, int_names, bool_names, list_names, depth):
    if depth <= 0 or rng.random() < 0.4:
        left = gen_arith(rng, int_names, list_names, 1)
        right = gen_arith(rng, int_names, list_names, 1)
        return f"({left} {rng.choice(COMPARISONS)} {right})"
    if bool_names and rng.random() < 0.3:
        return rng.choice(bool_names)
    if rng.random() < 0.25:
        return "(not " + gen_bool(
            rng, int_names, bool_names, list_names, depth - 1
        ) + ")"
    op = rng.choice(["and", "or"])
    return "(" + gen_bool(rng, int_names, bool_names, list_names, depth - 1) \
        + " " + op + " " + gen_bool(
            rng, int_names, bool_names, list_names, depth - 1
        ) + ")"


def gen_spec(rng):
    while True:
        count = rng.randint(1, 4)
        names = rng.sample(NAME_POOL, count)
        variables = []
        int_names, bool_names, list_names = [], [], []
        total = 1
        for name in names:
            domain = gen_domain(rng)
            variables.append(dict({"name": name}, **domain))
            total *= space_size(domain)
            if domain["type"] == "int":
                int_names.append(name)
            elif domain["type"] == "bool":
                bool_names.append(name)
            else:
                list_names.append(name)
        if total <= MAX_SPACE:
            break
    predicate = gen_bool(rng, int_names, bool_names, list_names, depth=3)
    return {"variables": variables, "predicate": predicate}


# --------------------------------------------------------------------------
# Independent brute-force reference
# --------------------------------------------------------------------------

def ref_values(node, default_bound):
    kind = node["type"]
    if kind == "int":
        bound = node.get("bound", default_bound)
        return list(range(-bound, bound + 1))
    if kind == "bool":
        return [False, True]
    elems = ref_values(node["elem"], default_bound)
    values = []
    for length in range(node["max_len"] + 1):
        values.extend(itertools.product(elems, repeat=length))
    return values


def ref_cost(node, value):
    kind = node["type"]
    if kind == "int":
        return abs(value)
    if kind == "bool":
        return int(value)
    return len(value) + sum(
        ref_cost(node["elem"], elem) for elem in value
    )


def reference_search(spec, default_bound, max_steps):
    domains = [
        ref_values(var, default_bound) for var in spec["variables"]
    ]
    nodes = spec["variables"]

    def ordering(assignment):
        return (
            sum(ref_cost(var, val) for var, val in zip(nodes, assignment)),
            assignment,
        )

    assignments = sorted(itertools.product(*domains), key=ordering)
    code = compile(spec["predicate"], "<reference>", "eval")
    names = [var["name"] for var in nodes]
    enumerated = 0
    for assignment in assignments:
        if max_steps is not None and enumerated >= max_steps:
            return UNKNOWN, None, enumerated
        enumerated += 1
        env = dict(SAFE_FUNCS)
        env.update(zip(names, assignment))
        holds = eval(code, {"__builtins__": {}}, env)
        assert isinstance(holds, bool)
        if not holds:
            return COUNTEREXAMPLE, assignment, enumerated
    return PROOF, None, enumerated


def cegen_assignment_tuple(result, names):
    out = []
    for name in names:
        value = result.counterexample[name]
        out.append(tuple(value) if isinstance(value, list) else value)
    return tuple(out)


class RandomEquivalenceTests(unittest.TestCase):
    def test_matches_itertools_reference(self):
        rng = random.Random(SEED)
        status_counts = {
            COUNTEREXAMPLE: 0, PROOF: 0, UNKNOWN: 0,
        }
        for case in range(NUM_SPECS):
            spec = gen_spec(rng)
            max_steps = None
            if rng.random() < 0.35:
                max_steps = rng.randint(0, MAX_SPACE)
            result = search(
                parse_spec(spec, DEFAULT_BOUND), max_steps=max_steps
            )
            ref_status, ref_ce, ref_enum = reference_search(
                spec, DEFAULT_BOUND, max_steps
            )
            self.assertEqual(
                result.status, ref_status,
                msg=f"case {case}: {spec}",
            )
            self.assertEqual(
                result.stats["enumerated"], ref_enum,
                msg=f"case {case}: {spec}",
            )
            if result.status == COUNTEREXAMPLE:
                names = [var["name"] for var in spec["variables"]]
                got = cegen_assignment_tuple(result, names)
                self.assertEqual(got, ref_ce, msg=f"case {case}: {spec}")
                # Independent minimality check: no earlier assignment in the
                # reference ordering can violate the invariant.
                domains = [
                    ref_values(var, DEFAULT_BOUND) for var in spec["variables"]
                ]
                nodes = spec["variables"]
                ce_key = (
                    sum(ref_cost(v, x) for v, x in zip(nodes, got)),
                    got,
                )
                code = compile(spec["predicate"], "<reference>", "eval")
                for other in itertools.product(*domains):
                    other_key = (
                        sum(ref_cost(v, x) for v, x in zip(nodes, other)),
                        other,
                    )
                    if other_key >= ce_key:
                        continue
                    env = dict(SAFE_FUNCS)
                    env.update(zip(names, other))
                    self.assertTrue(
                        eval(code, {"__builtins__": {}}, env),
                        msg=f"case {case}: smaller CE exists: {spec}",
                    )
                status_counts[COUNTEREXAMPLE] += 1
            elif result.status == PROOF:
                self.assertIn("closure_hash", result.stats)
                status_counts[PROOF] += 1
            else:
                self.assertNotIn("closure_hash", result.stats)
                status_counts[UNKNOWN] += 1
        # Sanity: the random suite actually exercises every terminal state.
        self.assertGreater(status_counts[COUNTEREXAMPLE], 0, status_counts)
        self.assertGreater(status_counts[PROOF], 0, status_counts)
        self.assertGreater(status_counts[UNKNOWN], 0, status_counts)


if __name__ == "__main__":
    unittest.main()
