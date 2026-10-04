"""Rule-set expressions: patterns combined with union and difference."""

from dataclasses import dataclass

from .chars import OTHER, SEPARATOR, alphabet_for
from .dfa import (
    Budget,
    determinize,
    empty_dfa,
    legal_dfa,
    product_multi,
)
from .nfa import compile_pattern_nfa
from .normalize import normalize_path
from .pattern import parse_pattern, pattern_predicates


class RulesetError(ValueError):
    """Raised for malformed rule-set expressions."""


@dataclass(frozen=True)
class Pattern:
    text: str


@dataclass(frozen=True)
class Union:
    parts: tuple


@dataclass(frozen=True)
class Minus:
    left: object
    right: object


class BudgetExhausted(Exception):
    def __init__(self, frontier):
        super().__init__("state budget exhausted")
        self.frontier = frontier


def expr_from_json(obj):
    """Parse a JSON rule expression.

    ``"a/**"``                                  -> a single pattern
    ``{"pattern": "a/**"}``                     -> a single pattern
    ``{"union": [e1, e2, ...]}``                -> union
    ``{"minus": [e1, e2]}``                     -> difference
    ``{"allow": [...], "deny": [...]}``         -> policy: allow minus deny
    (``allow`` defaults to ``["**"]``, ``deny`` defaults to empty)
    """
    if isinstance(obj, str):
        return Pattern(obj)
    if isinstance(obj, dict):
        if "pattern" in obj:
            return Pattern(obj["pattern"])
        if "union" in obj:
            return Union(tuple(expr_from_json(x) for x in obj["union"]))
        if "minus" in obj:
            left, right = obj["minus"]
            return Minus(expr_from_json(left), expr_from_json(right))
        if "allow" in obj or "deny" in obj:
            allow = obj.get("allow", ["**"])
            deny = obj.get("deny", [])
            allowed = Union(tuple(expr_from_json(x) for x in allow))
            if not deny:
                return allowed
            return Minus(allowed, Union(tuple(expr_from_json(x) for x in deny)))
    raise RulesetError("invalid rule expression: %r" % (obj,))


def expr_to_json(expr):
    if isinstance(expr, Pattern):
        return {"pattern": expr.text}
    if isinstance(expr, Union):
        return {"union": [expr_to_json(p) for p in expr.parts]}
    if isinstance(expr, Minus):
        return {"minus": [expr_to_json(expr.left), expr_to_json(expr.right)]}
    raise RulesetError("unknown expression")  # pragma: no cover


def predicates_of(expr):
    preds = set()
    if isinstance(expr, Pattern):
        preds.update(pattern_predicates(parse_pattern(expr.text)))
    elif isinstance(expr, Union):
        for part in expr.parts:
            preds.update(predicates_of(part))
    elif isinstance(expr, Minus):
        preds.update(predicates_of(expr.left))
        preds.update(predicates_of(expr.right))
    else:
        raise RulesetError("unknown expression: %r" % (expr,))
    return preds


def alphabet_of(*exprs):
    preds = set()
    for expr in exprs:
        preds.update(predicates_of(expr))
    return alphabet_for(preds)


def compile_expr(expr, alphabet, budget):
    """Compile an expression to a complete DFA over ``alphabet``."""
    if isinstance(expr, Pattern):
        result = determinize(compile_pattern_nfa(expr.text), alphabet, budget)
        if not result.done:
            raise BudgetExhausted(result.frontier_json())
        return result.dfa.make_complete()
    if isinstance(expr, Union):
        if not expr.parts:
            return empty_dfa(alphabet)
        acc = compile_expr(expr.parts[0], alphabet, budget)
        for part in expr.parts[1:]:
            nxt = compile_expr(part, alphabet, budget)
            result = product_multi([acc, nxt], any, budget)
            if not result.done:
                raise BudgetExhausted(result.frontier_json())
            acc = result.dfa
        return acc
    if isinstance(expr, Minus):
        left = compile_expr(expr.left, alphabet, budget)
        right = compile_expr(expr.right, alphabet, budget)
        # The complement is taken relative to the legal path language L,
        # not relative to arbitrary strings:  A \ B == A n (L \ B).
        result = product_multi(
            [left, right.complemented(), legal_dfa(alphabet)],
            lambda flags: all(flags),
            budget,
        )
        if not result.done:
            raise BudgetExhausted(result.frontier_json())
        return result.dfa
    raise RulesetError("unknown expression")  # pragma: no cover


def run_dfa(dfa, normalized_path):
    mentioned = {s for s in dfa.alphabet if s is not OTHER and s != SEPARATOR}
    state = dfa.start
    for ch in normalized_path:
        if ch == SEPARATOR:
            sym = SEPARATOR
        elif ch in mentioned:
            sym = ch
        else:
            sym = OTHER
        state = dfa.trans[state].get(sym)
        if state is None:
            return False
    return state in dfa.accepts


def expr_dfa(expr, budget=None):
    return compile_expr(expr, alphabet_of(expr), budget or Budget())


def expr_match(expr, path):
    """Normalize ``path`` (rejecting root escapes) and match ``expr``."""
    normalized = normalize_path(path)
    return run_dfa(expr_dfa(expr), normalized)
