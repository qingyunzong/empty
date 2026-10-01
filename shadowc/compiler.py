"""Compiler: builds the decision table and shadow/overlap diagnostics.

Diagnostics never change evaluation: the decision table always contains all
rules in source order and evaluation is plain first-match-wins.
"""

from __future__ import annotations

from dataclasses import dataclass, field as _field

from . import nodes
from .parser import parse_policy
from .space import (
    int_interval,
    int_normalize,
    space_complement,
    space_intersect,
    space_is_empty,
    space_member,
    space_subset,
    str_cylinder,
    str_exact,
    str_normalize,
)

SEVERITY = {"E_PARSE": "error", "E_SHADOW": "error", "E_UNREACHABLE": "error", "W_OVERLAP": "warning"}


@dataclass
class Diagnostic:
    code: str
    severity: str
    message: str
    line: int
    col: int
    rule: str = None
    related: str = None

    def to_dict(self):
        out = {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "line": self.line,
            "col": self.col,
        }
        if self.rule is not None:
            out["rule"] = self.rule
        if self.related is not None:
            out["related"] = self.related
        return out


@dataclass
class CompiledRule:
    name: str
    actions: list
    line: int
    col: int
    cond: object
    space: list


@dataclass
class CompiledPolicy:
    schema: dict
    actions: list
    rules: list
    diagnostics: list
    alphabet: frozenset = _field(default=frozenset())

    def table(self):
        return [
            {
                "index": i,
                "name": r.name,
                "line": r.line,
                "actions": list(r.actions),
                "condition": render_cond(r.cond),
            }
            for i, r in enumerate(self.rules)
        ]

    def report(self):
        return {
            "table": self.table(),
            "diagnostics": [d.to_dict() for d in self.diagnostics],
        }

    def evaluate(self, inputs):
        """First-match-wins over the table; diagnostics are irrelevant here."""
        for name in self.schema:
            if name not in inputs:
                raise ValueError(f"missing input field {name!r}")
        for rule in self.rules:
            if space_member(rule.space, self.schema, inputs):
                return list(rule.actions)
        return None


# --------------------------------------------------------------------------
# condition -> space
# --------------------------------------------------------------------------


def _compute_alphabet(policy):
    chars = {"\x00"}  # sentinel for "any character not named in the policy"
    for rule in policy.rules:
        for node in _walk(rule.cond):
            if isinstance(node, nodes.StrPatterns):
                for text, _ in node.patterns:
                    chars.update(text)
    return frozenset(chars)


def _walk(node):
    yield node
    if isinstance(node, (nodes.Or, nodes.And)):
        yield from _walk(node.left)
        yield from _walk(node.right)
    elif isinstance(node, nodes.Not):
        yield from _walk(node.operand)


def cond_space(cond, schema, alphabet):
    if isinstance(cond, nodes.Or):
        return cond_space(cond.left, schema, alphabet) + cond_space(
            cond.right, schema, alphabet
        )
    if isinstance(cond, nodes.And):
        return space_intersect(
            cond_space(cond.left, schema, alphabet),
            cond_space(cond.right, schema, alphabet),
            schema,
        )
    if isinstance(cond, nodes.Not):
        return space_complement(cond_space(cond.operand, schema, alphabet), schema, alphabet)
    if isinstance(cond, nodes.Interval):
        return [{cond.field: int_interval(cond.lo, cond.hi)}]
    if isinstance(cond, nodes.IntValues):
        return [{cond.field: int_normalize([(v, v) for v in cond.values])}]
    if isinstance(cond, nodes.StrPatterns):
        exact = set()
        cyls = []
        for text, is_prefix in cond.patterns:
            if is_prefix:
                cyls.append(text)
            else:
                exact.add(text)
        return [{cond.field: str_normalize(exact, cyls)}]
    if isinstance(cond, nodes.EnumValues):
        return [{cond.field: cond.values}]
    raise TypeError(f"unknown condition node: {cond!r}")


# --------------------------------------------------------------------------
# diagnostics
# --------------------------------------------------------------------------


def compute_diagnostics(rules, schema, alphabet):
    diagnostics = []
    earlier = []  # list of (rule, space)
    for rule in rules:
        space = rule.space
        if space_is_empty(space, schema):
            diagnostics.append(
                Diagnostic(
                    "E_UNREACHABLE",
                    SEVERITY["E_UNREACHABLE"],
                    f"rule {rule.name!r} is unreachable: its condition is unsatisfiable",
                    rule.line,
                    rule.col,
                    rule=rule.name,
                )
            )
        else:
            shadower = None
            for prev_rule, prev_space in earlier:
                if space_subset(space, prev_space, schema, alphabet):
                    shadower = prev_rule
                    break
            if shadower is not None:
                diagnostics.append(
                    Diagnostic(
                        "E_SHADOW",
                        SEVERITY["E_SHADOW"],
                        f"rule {rule.name!r} is fully shadowed by earlier rule "
                        f"{shadower.name!r}",
                        rule.line,
                        rule.col,
                        rule=rule.name,
                        related=shadower.name,
                    )
                )
            else:
                remaining = space
                for _, prev_space in earlier:
                    remaining = space_intersect(
                        remaining,
                        space_complement(prev_space, schema, alphabet),
                        schema,
                    )
                    if space_is_empty(remaining, schema):
                        break
                if space_is_empty(remaining, schema):
                    diagnostics.append(
                        Diagnostic(
                            "E_UNREACHABLE",
                            SEVERITY["E_UNREACHABLE"],
                            f"rule {rule.name!r} is unreachable: its input space is "
                            "covered by the union of earlier rules",
                            rule.line,
                            rule.col,
                            rule=rule.name,
                        )
                    )
                else:
                    for prev_rule, prev_space in earlier:
                        if space_is_empty(space_intersect(space, prev_space, schema), schema):
                            continue
                        if space_subset(prev_space, space, schema, alphabet):
                            continue  # earlier rule is contained in this one
                        if space_subset(space, prev_space, schema, alphabet):
                            continue  # cannot happen (would be E_SHADOW)
                        diagnostics.append(
                            Diagnostic(
                                "W_OVERLAP",
                                SEVERITY["W_OVERLAP"],
                                f"rule {rule.name!r} overlaps earlier rule "
                                f"{prev_rule.name!r} but neither contains the other",
                                rule.line,
                                rule.col,
                                rule=rule.name,
                                related=prev_rule.name,
                            )
                        )
        earlier.append((rule, space))
    return diagnostics


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------


def render_cond(cond):
    if isinstance(cond, nodes.Or):
        return f"({render_cond(cond.left)} or {render_cond(cond.right)})"
    if isinstance(cond, nodes.And):
        return f"({render_cond(cond.left)} and {render_cond(cond.right)})"
    if isinstance(cond, nodes.Not):
        return f"(not {render_cond(cond.operand)})"
    if isinstance(cond, nodes.Interval):
        return f"{cond.field} in {cond.lo}..{cond.hi}"
    if isinstance(cond, nodes.IntValues):
        values = sorted(cond.values)
        if len(values) == 1:
            return f"{cond.field} == {values[0]}"
        return f"{cond.field} in {{{', '.join(str(v) for v in values)}}}"
    if isinstance(cond, nodes.StrPatterns):
        parts = [f'"{text}*"' if is_prefix else f'"{text}"' for text, is_prefix in cond.patterns]
        if len(parts) == 1:
            return f"{cond.field} == {parts[0]}"
        return f"{cond.field} in {{{', '.join(parts)}}}"
    if isinstance(cond, nodes.EnumValues):
        values = sorted(cond.values)
        if len(values) == 1:
            return f"{cond.field} == {values[0]}"
        return f"{cond.field} in {{{', '.join(values)}}}"
    raise TypeError(f"unknown condition node: {cond!r}")


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def compile_source(source: str) -> CompiledPolicy:
    policy = parse_policy(source)
    schema = {f.name: f.ftype for f in policy.fields}
    alphabet = _compute_alphabet(policy)
    rules = [
        CompiledRule(
            r.name,
            list(r.actions),
            r.line,
            r.col,
            r.cond,
            cond_space(r.cond, schema, alphabet),
        )
        for r in policy.rules
    ]
    diagnostics = compute_diagnostics(rules, schema, alphabet)
    return CompiledPolicy(schema, list(policy.actions), rules, diagnostics, alphabet)
