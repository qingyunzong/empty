"""Small forward-chaining rule engine.

Rules have the form ``head :- a, b, not c`` (whitespace tolerant).  Facts are
ground atoms.  The engine distinguishes *base* facts (asserted by the user)
from *derived* facts (produced by rules).  A derived fact may have several
independent proofs; it is withdrawn only when every proof becomes invalid.

Semantics of ``not``: a negative literal is satisfied when the atom is not
present in the fact set *at the moment the rule is evaluated*.  Derivation
runs in rounds; inside a round rules are evaluated in ascending rule id and
the fact set is consulted/extended in lexicographically deterministic order,
so the whole process is deterministic.  Because rule heads belong to the
finite universe of atoms mentioned by the program, saturation always
converges, even with cyclic rules.

The engine keeps, for every derived fact, the list of its supports (proofs)
and a reverse dependency index mapping each fact to the supports that use it
as a positive premise.  Retraction therefore invalidates exactly the
derivations whose proofs depended on the removed fact; anything still
provable (including facts newly enabled by a disappearing ``not`` premise)
is re-established by re-saturation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

ATOM_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\([A-Za-z0-9_]*(,[A-Za-z0-9_]*)*\))?")


class RuleSyntaxError(ValueError):
    """Raised when a rule or fact string cannot be parsed."""


class DerivedFactError(ValueError):
    """Raised when trying to assert a fact that is currently derived."""


class NotBaseFactError(ValueError):
    """Raised when trying to retract a fact that is not a base fact."""


def _split_top_level(text: str, sep: str = ",") -> list[str]:
    parts: list[str] = []
    depth = 0
    start = 0
    for index, ch in enumerate(text):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append(text[start:index])
            start = index + 1
    parts.append(text[start:])
    return parts


def parse_atom(text: str) -> str:
    compact = re.sub(r"\s+", "", text)
    if not compact or not ATOM_RE.fullmatch(compact):
        raise RuleSyntaxError(f"invalid atom: {text!r}")
    return compact


def parse_literal(text: str) -> tuple[bool, str]:
    stripped = text.strip()
    negative = False
    if stripped == "not":
        raise RuleSyntaxError(f"dangling 'not' in literal: {text!r}")
    if stripped.startswith("not") and stripped[3].isspace():
        negative = True
        stripped = stripped[3:].strip()
    return negative, parse_atom(stripped)


@dataclass(frozen=True)
class Rule:
    id: int
    head: str
    pos: tuple[str, ...] = ()
    neg: tuple[str, ...] = ()

    def __str__(self) -> str:
        body = [*(p for p in self.pos), *(f"not {n}" for n in self.neg)]
        return f"{self.head}:-{','.join(body)}" if body else self.head


def parse_rule(rule_id: int, text: str) -> Rule:
    if ":-" in text:
        head_text, body_text = text.split(":-", 1)
        head = parse_atom(head_text)
        body_text = body_text.strip()
        if not body_text:
            raise RuleSyntaxError(f"empty rule body: {text!r}")
        pos: list[str] = []
        neg: list[str] = []
        if body_text:
            for chunk in _split_top_level(body_text):
                if not chunk.strip():
                    raise RuleSyntaxError(f"empty literal in rule body: {text!r}")
                negative, atom = parse_literal(chunk)
                (neg if negative else pos).append(atom)
        return Rule(rule_id, head, tuple(pos), tuple(neg))
    return Rule(rule_id, parse_atom(text))


@dataclass(frozen=True)
class Support:
    """One proof of a derived fact."""

    rule_id: int
    pos: tuple[str, ...]
    neg: tuple[str, ...]


class Engine:
    def __init__(self) -> None:
        self.base: set[str] = set()
        self.rules: list[Rule] = []
        self._next_rule_id = 0
        self._supports: dict[str, list[Support]] = {}
        self._dependents: dict[str, set[int]] = {}
        self._recompute()

    # ------------------------------------------------------------------ queries
    @property
    def derived(self) -> set[str]:
        return set(self._supports) - self.base

    @property
    def facts(self) -> set[str]:
        return self.base | set(self._supports)

    def derives(self, fact: str) -> bool:
        return fact in self.facts

    def is_derived(self, fact: str) -> bool:
        return fact in self.derived

    def proofs(self, fact: str) -> list[Support]:
        return list(self._supports.get(fact, ()))

    def dependents_of(self, fact: str) -> set[int]:
        """Rule ids whose positive premises mention ``fact`` (reverse index)."""
        return set(self._dependents.get(fact, ()))

    # ----------------------------------------------------------------- mutations
    def add_rule(self, text: str) -> Rule:
        rule = parse_rule(self._next_rule_id, text)
        self._next_rule_id += 1
        self.rules.append(rule)
        self._recompute()
        return rule

    def assert_fact(self, fact: str) -> None:
        atom = parse_atom(fact)
        if atom in self.derived:
            raise DerivedFactError(f"cannot assert derived fact: {atom}")
        if atom not in self.base:
            self.base.add(atom)
            self._recompute()

    def retract_fact(self, fact: str) -> None:
        atom = parse_atom(fact)
        if atom not in self.base:
            raise NotBaseFactError(f"not a base fact: {atom}")
        self.base.discard(atom)
        self._recompute()

    # ----------------------------------------------------------------- internals
    def _recompute(self) -> None:
        """Saturate from scratch and rebuild supports + reverse dependencies.

        Facts are only ever added inside one saturation run and rule heads
        come from the finite atom universe, so this always terminates.
        Only derivations whose proofs are still valid survive a recompute,
        which is exactly the set of necessary invalidations after a change.
        """
        facts = set(self.base)
        supports: dict[str, list[Support]] = {}
        fired: set[int] = set()
        changed = True
        while changed:
            changed = False
            for rule in sorted(self.rules, key=lambda r: r.id):
                if rule.id in fired:
                    continue
                if all(p in facts for p in rule.pos) and all(
                    n not in facts for n in rule.neg
                ):
                    fired.add(rule.id)
                    supports.setdefault(rule.head, []).append(
                        Support(rule.id, rule.pos, rule.neg)
                    )
                    if rule.head not in facts:
                        facts.add(rule.head)
                        changed = True
        self._supports = supports
        dependents: dict[str, set[int]] = {}
        for rule in self.rules:
            for premise in rule.pos:
                dependents.setdefault(premise, set()).add(rule.id)
        self._dependents = dependents
