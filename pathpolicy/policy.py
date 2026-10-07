"""Rule sets (union / difference), inclusion, equivalence, witnesses.

A policy is ``{"allow": [...patterns], "deny": [...patterns]}`` and denotes
the set of canonical paths matched by some allow pattern and no deny
pattern.  Inclusion and equivalence are decided exactly on the product of
subset constructions, intersected with the legal-path language, so the
complement in a difference is always relative to legal paths -- never to
arbitrary strings.

Results:
  - ``included``     -> carries an independently verifiable certificate
                        (the full explored product graph; emptiness is
                        re-checkable, not sampled),
  - ``not_included`` -> carries a shortest difference witness, re-checked
                        by normalization and by both interpreters,
  - ``unknown``      -> state budget exhausted; carries a checkpoint with
                        the recoverable frontier for resumption.
"""
from .automata import NFA, ProductMachine, Exploration
from .compiler import compile_pattern, legal_nfa
from .interpreter import match_policy
from .normalize import normalize_path, PathError
from .pattern import parse_pattern

DEFAULT_BUDGET = 50000


class Policy:
    """A whitelist minus blacklist rule set."""

    def __init__(self, allow=(), deny=()):
        self.allow = tuple(allow)
        self.deny = tuple(deny)
        for p in self.allow + self.deny:
            if not isinstance(p, str):
                raise ValueError("patterns must be strings: %r" % (p,))

    @staticmethod
    def from_json(obj):
        if isinstance(obj, str):
            return Policy([obj])
        if isinstance(obj, list):
            return Policy(obj)
        if isinstance(obj, dict):
            unknown = set(obj) - {"allow", "deny"}
            if unknown:
                raise ValueError("unknown policy keys: %r" % sorted(unknown))
            return Policy(obj.get("allow", []), obj.get("deny", []))
        raise ValueError("cannot read a policy from %r" % (obj,))

    def to_json(self):
        return {"allow": list(self.allow), "deny": list(self.deny)}

    def __repr__(self):
        return "Policy(allow=%r, deny=%r)" % (self.allow, self.deny)


def _union_nfa(pattern_strings):
    return NFA.union([compile_pattern(parse_pattern(p))
                      for p in pattern_strings])


def _serialize_state(state):
    return [sorted(sub) for sub in state]


def _deserialize_state(data):
    return tuple(frozenset(sub) for sub in data)


class InclusionChecker:
    """Decides (allowL \\ denyL) subset-of (allowR \\ denyR) exactly."""

    def __init__(self, left, right):
        self.left = left
        self.right = right
        self.nfas = [
            _union_nfa(left.allow),
            _union_nfa(left.deny),
            _union_nfa(right.allow),
            _union_nfa(right.deny),
            legal_nfa(),
        ]

        def accept_fn(flags):
            return (flags[0] and not flags[1]
                    and (not flags[2] or flags[3]) and flags[4])

        self.machine = ProductMachine(self.nfas, accept_fn)
        self.exploration = Exploration(self.machine)

    def run(self, budget=DEFAULT_BUDGET, all_shortest=False,
            witness_limit=32):
        status, witnesses = self.exploration.run(
            budget, all_shortest=all_shortest, witness_limit=witness_limit)
        if status == "empty":
            return {
                "result": "included",
                "states_explored": len(self.exploration.states),
                "certificate": self.certificate(),
            }
        if status == "found":
            verified = [self._verify_witness(w) for w in witnesses]
            return {
                "result": "not_included",
                "witness": verified[0],
                "all_shortest": verified,
                "states_explored": len(self.exploration.states),
                "certificate": {
                    "type": "difference-witness",
                    "left": self.left.to_json(),
                    "right": self.right.to_json(),
                    "witness": witnesses[0],
                },
            }
        return {
            "result": "unknown",
            "reason": "state budget exhausted",
            "states_explored": len(self.exploration.states),
            "checkpoint": self.checkpoint(),
        }

    def _verify_witness(self, w):
        norm = normalize_path(w)
        left_match = match_policy(self.left, w)
        right_match = match_policy(self.right, w)
        if norm != w or not left_match or right_match:
            raise AssertionError(
                "automaton/interpreter disagreement on witness %r" % (w,))
        return {
            "path": w,
            "normalized": norm,
            "left_match": left_match,
            "right_match": right_match,
        }

    def certificate(self):
        return {
            "type": "inclusion-proof",
            "left": self.left.to_json(),
            "right": self.right.to_json(),
            "nfas": [nfa.to_json() for nfa in self.nfas],
            "minterms": [m.to_json() for m in self.machine.minterms],
            "states": [_serialize_state(s) for s in self.exploration.states],
            "transitions": [list(t) for t in self.exploration.transitions],
        }

    def checkpoint(self):
        return {
            "type": "inclusion-checkpoint",
            "left": self.left.to_json(),
            "right": self.right.to_json(),
            "exploration": self.exploration.to_json(),
        }

    @staticmethod
    def from_checkpoint(cp):
        if cp.get("type") != "inclusion-checkpoint":
            raise ValueError("not an inclusion checkpoint")
        checker = InclusionChecker(Policy.from_json(cp["left"]),
                                   Policy.from_json(cp["right"]))
        checker.exploration.load_json(cp["exploration"])
        return checker


def check_inclusion(left, right, budget=DEFAULT_BUDGET, all_shortest=False):
    """Check left subset-of right.  See module docstring for result shape."""
    checker = InclusionChecker(left, right)
    return checker.run(budget=budget, all_shortest=all_shortest)


def check_equivalent(left, right, budget=DEFAULT_BUDGET):
    """Check both inclusions; equivalent iff both hold."""
    r1 = check_inclusion(left, right, budget)
    if r1["result"] == "not_included":
        return {"result": "not_equivalent", "direction": "left\\right",
                "witness": r1["witness"], "certificate": r1["certificate"]}
    if r1["result"] == "unknown":
        return {"result": "unknown", "phase": "left\\right",
                "checkpoint": r1["checkpoint"]}
    r2 = check_inclusion(right, left, budget)
    if r2["result"] == "not_included":
        return {"result": "not_equivalent", "direction": "right\\left",
                "witness": r2["witness"], "certificate": r2["certificate"]}
    if r2["result"] == "unknown":
        return {"result": "unknown", "phase": "right\\left",
                "checkpoint": r2["checkpoint"]}
    return {"result": "equivalent",
            "certificates": [r1["certificate"], r2["certificate"]]}


def find_difference(left, right, budget=DEFAULT_BUDGET, all_shortest=False):
    """Shortest path(s) allowed by ``left`` but not by ``right``."""
    return check_inclusion(left, right, budget=budget,
                           all_shortest=all_shortest)


def verify_certificate(cert):
    """Independently re-verify a certificate produced by this library.

    For an inclusion proof the whole product graph is recomputed from the
    policies and checked transition by transition; for a difference
    witness the path is re-normalized and re-matched by the independent
    recursive interpreter on both sides.
    """
    ctype = cert.get("type")
    if ctype == "difference-witness":
        left = Policy.from_json(cert["left"])
        right = Policy.from_json(cert["right"])
        w = cert["witness"]
        try:
            if normalize_path(w) != w:
                return False
        except PathError:
            return False
        return match_policy(left, w) and not match_policy(right, w)
    if ctype != "inclusion-proof":
        raise ValueError("unknown certificate type: %r" % (ctype,))
    checker = InclusionChecker(Policy.from_json(cert["left"]),
                               Policy.from_json(cert["right"]))
    machine = checker.machine
    if [nfa.to_json() for nfa in checker.nfas] != cert["nfas"]:
        return False
    if [m.to_json() for m in machine.minterms] != cert["minterms"]:
        return False
    states = [_deserialize_state(s) for s in cert["states"]]
    if not states or states[0] != machine.start_state():
        return False
    if len(set(states)) != len(states):
        return False
    trans = {}
    for (s, mi, t) in cert["transitions"]:
        if (s, mi) in trans:
            return False
        trans[(s, mi)] = t
    n_min = len(machine.minterms)
    for i, st in enumerate(states):
        if machine.accepts(st):
            return False
        for mi in range(n_min):
            j = trans.get((i, mi))
            if j is None or not (0 <= j < len(states)):
                return False
            if states[j] != machine.step(st, mi):
                return False
    seen = {0}
    stack = [0]
    while stack:
        i = stack.pop()
        for mi in range(n_min):
            j = trans[(i, mi)]
            if j not in seen:
                seen.add(j)
                stack.append(j)
    return seen == set(range(len(states)))
