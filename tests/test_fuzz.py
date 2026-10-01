"""Fuzz test (item E): random small policies (<= 80 rules) must produce the
same diagnostic *categories* as a sampling-based reference inclusion check.

The reference decides shadow / unreachable / overlap purely by evaluating
conditions on a dense grid of sample inputs (interval boundary points,
prefix neighbourhoods, full enum domain).  For the literal pools used by the
generator the grid hits every cell of the induced input partition, so the
comparison is deterministic; the exact compiler must agree with it on every
rule.
"""

import itertools
import random
import unittest

from shadowc import compile_source, nodes
from shadowc.parser import parse_policy

INT_FIELDS = ("a", "b")
ENUM_DOMAIN = ("x", "y", "z")
STR_LITERALS = (
    "a", "b", "aa", "ab", "ba", "bb", "a*", "b*", "aa*", "ab*", "ba*",
)

PRELUDE = (
    "field a: int\n"
    "field b: int\n"
    "field s: string\n"
    "field e: enum(x, y, z)\n"
    "action allow\n"
    "action deny\n"
    "action log\n"
)


# ---------------------------------------------------------------------
# policy generator
# ---------------------------------------------------------------------


def gen_atom(rng):
    kind = rng.random()
    if kind < 0.4:
        field = rng.choice(INT_FIELDS)
        sub = rng.random()
        if sub < 0.5:
            lo = rng.randint(0, 7)
            return f"{field} in {lo}..{rng.randint(lo, 7)}"
        if sub < 0.75:
            return f"{field} == {rng.randint(0, 7)}"
        vals = sorted(rng.sample(range(8), rng.randint(1, 3)))
        return f"{field} in {{{', '.join(map(str, vals))}}}"
    if kind < 0.75:
        lits = rng.sample(STR_LITERALS, rng.randint(1, 2))
        if len(lits) == 1:
            return f's == "{lits[0]}"'
        return "s in {" + ", ".join(f'"{lit}"' for lit in lits) + "}"
    vals = rng.sample(ENUM_DOMAIN, rng.randint(1, 2))
    if len(vals) == 1:
        return f"e == {vals[0]}"
    return "e in {" + ", ".join(vals) + "}"


def gen_cond(rng, depth=0):
    if depth >= 2:
        return gen_atom(rng)
    r = rng.random()
    if r < 0.55:
        return gen_atom(rng)
    if r < 0.70:
        return f"{gen_cond(rng, depth + 1)} and {gen_cond(rng, depth + 1)}"
    if r < 0.85:
        return f"{gen_cond(rng, depth + 1)} or {gen_cond(rng, depth + 1)}"
    return f"not {gen_cond(rng, depth + 1)}"


def gen_policy(rng, n_rules):
    lines = [PRELUDE]
    for i in range(n_rules):
        actions = ", ".join(rng.sample(["allow", "deny", "log"], rng.randint(1, 2)))
        lines.append(f"rule r{i} when {gen_cond(rng)} then {actions}\n")
    return "".join(lines)


# ---------------------------------------------------------------------
# sampling-based reference
# ---------------------------------------------------------------------


def walk(node):
    yield node
    if isinstance(node, (nodes.Or, nodes.And)):
        yield from walk(node.left)
        yield from walk(node.right)
    elif isinstance(node, nodes.Not):
        yield from walk(node.operand)


def eval_node(node, inp):
    if isinstance(node, nodes.Or):
        return eval_node(node.left, inp) or eval_node(node.right, inp)
    if isinstance(node, nodes.And):
        return eval_node(node.left, inp) and eval_node(node.right, inp)
    if isinstance(node, nodes.Not):
        return not eval_node(node.operand, inp)
    if isinstance(node, nodes.Interval):
        return node.lo <= inp[node.field] <= node.hi
    if isinstance(node, nodes.IntValues):
        return inp[node.field] in node.values
    if isinstance(node, nodes.StrPatterns):
        value = inp[node.field]
        return any(
            value == text or (is_prefix and value.startswith(text))
            for text, is_prefix in node.patterns
        )
    if isinstance(node, nodes.EnumValues):
        return inp[node.field] in node.values
    raise TypeError(node)


def sample_inputs(policy):
    int_lits = set()
    str_texts = set()
    for rule in policy.rules:
        for node in walk(rule.cond):
            if isinstance(node, nodes.Interval):
                int_lits.update((node.lo, node.hi))
            elif isinstance(node, nodes.IntValues):
                int_lits.update(node.values)
            elif isinstance(node, nodes.StrPatterns):
                str_texts.update(text for text, _ in node.patterns)
    int_cands = {0}
    for v in int_lits:
        int_cands.update((v - 1, v, v + 1))
    int_cands = sorted(int_cands)
    maxlen = max((len(t) for t in str_texts), default=1)
    str_cands = {"", "\x00"}
    for text in str_texts:
        for i in range(len(text) + 1):
            str_cands.add(text[:i])
        str_cands.add(text + "\x00")
    for length in range(1, maxlen + 2):
        for combo in itertools.product("ab", repeat=length):
            str_cands.add("".join(combo))
    str_cands = sorted(str_cands)
    return [
        {"a": a, "b": b, "s": s, "e": e}
        for a, b, s, e in itertools.product(
            int_cands, int_cands, str_cands, ENUM_DOMAIN
        )
    ]


def reference_categories(policy, samples):
    """Per-rule (error_code_or_None, frozenset of overlap-warning peers)."""
    universe = frozenset(range(len(samples)))
    atom_cache = {}

    def matched_set(node):
        if isinstance(
            node, (nodes.Interval, nodes.IntValues, nodes.StrPatterns, nodes.EnumValues)
        ):
            key = id(node)
            if key not in atom_cache:
                atom_cache[key] = {
                    k for k, inp in enumerate(samples) if eval_node(node, inp)
                }
            return atom_cache[key]
        if isinstance(node, nodes.Or):
            return matched_set(node.left) | matched_set(node.right)
        if isinstance(node, nodes.And):
            return matched_set(node.left) & matched_set(node.right)
        if isinstance(node, nodes.Not):
            return universe - matched_set(node.operand)
        raise TypeError(node)

    matched = [matched_set(rule.cond) for rule in policy.rules]
    cats = {}
    for i, rule in enumerate(policy.rules):
        current = matched[i]
        error = None
        warns = set()
        if not current:
            error = "E_UNREACHABLE"
        elif any(current <= matched[j] for j in range(i)):
            error = "E_SHADOW"
        else:
            union = set()
            for j in range(i):
                union |= matched[j]
            if current <= union:
                error = "E_UNREACHABLE"
            else:
                for j in range(i):
                    other = matched[j]
                    if other & current and not other <= current and not current <= other:
                        warns.add(policy.rules[j].name)
        cats[rule.name] = (error, frozenset(warns))
    return cats


def exact_categories(compiled):
    cats = {r.name: [None, set()] for r in compiled.rules}
    for diag in compiled.diagnostics:
        slot = cats[diag.rule]
        if diag.severity == "error":
            slot[0] = diag.code
        else:
            slot[1].add(diag.related)
    return {name: (err, frozenset(w)) for name, (err, w) in cats.items()}


# ---------------------------------------------------------------------
# the test
# ---------------------------------------------------------------------


class TestFuzzAgainstSamplingReference(unittest.TestCase):
    def check_policy(self, source, label):
        policy = parse_policy(source)
        compiled = compile_source(source)
        samples = sample_inputs(policy)
        expected = reference_categories(policy, samples)
        actual = exact_categories(compiled)
        for rule_name in expected:
            self.assertEqual(
                actual[rule_name],
                expected[rule_name],
                f"{label}: diagnostic category mismatch for rule {rule_name!r}\n"
                f"policy:\n{source}",
            )

    def test_small_random_policies(self):
        rng = random.Random(20261001)
        for trial in range(40):
            source = gen_policy(rng, rng.randint(1, 10))
            self.check_policy(source, f"small-{trial}")

    def test_large_random_policies_up_to_80_rules(self):
        rng = random.Random(808080)
        for trial in range(4):
            source = gen_policy(rng, 80)
            self.check_policy(source, f"large-{trial}")

    def test_medium_random_policies(self):
        rng = random.Random(424242)
        for trial in range(8):
            source = gen_policy(rng, rng.randint(11, 40))
            self.check_policy(source, f"medium-{trial}")


if __name__ == "__main__":
    unittest.main()
