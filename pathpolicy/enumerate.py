"""Enumeration of legal paths over small name sets.

Used to cross-check the automaton engine against the independent recursive
interpreter on every legal path up to a bounded depth.  This validates the
engines against each other; inclusion/equivalence claims themselves are
always decided by automaton emptiness, never by these samples.
"""

from itertools import product

from .dfa import Budget
from .interpreter import interp_match_normalized
from .ruleset import alphabet_of, compile_expr, run_dfa


def legal_paths(names, max_depth):
    """Every legal path whose segments come from ``names``, up to
    ``max_depth`` segments, including the root path ``""``."""
    yield ""
    for depth in range(1, max_depth + 1):
        for combo in product(names, repeat=depth):
            yield "/".join(combo)


def cross_check(expr, names, max_depth, budget=100000):
    dfa = compile_expr(expr, alphabet_of(expr), Budget(budget))
    checked = 0
    mismatches = []
    for path in legal_paths(names, max_depth):
        automaton = run_dfa(dfa, path)
        interpreter = interp_match_normalized(expr, path)
        checked += 1
        if automaton != interpreter:
            mismatches.append(
                {"path": path, "automaton": automaton, "interpreter": interpreter}
            )
    return {"checked": checked, "mismatches": mismatches}
