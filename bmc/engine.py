"""Bounded BFS model-checking engine.

Semantics implemented here:

1. States are canonicalised by sorting variable names; reading an
   undefined (declared but never assigned) variable is an E_READ error.
2. A transition is *enabled* only when its guard is true and every
   assigned value stays inside the domain [-9, 9]; otherwise the
   transition is silently disabled (never a crash).
3. Exploration is BFS layer order; the first state falsifying the
   invariant yields the shortest counterexample.
4. Reaching the bound without a violation reports SAFE_BOUNDED --
   never a claim of global safety.
5. A state already seen is never enqueued twice.
"""
from __future__ import annotations

from collections import deque

from .expr import EvaluationError, UndefinedVariableError, evaluate
from .model import DOMAIN_MAX, DOMAIN_MIN, Model

VIOLATION = "VIOLATION"
SAFE_BOUNDED = "SAFE_BOUNDED"
ERROR = "ERROR"

E_READ = "E_READ"


def canonical(state: dict) -> tuple:
    """Canonical form of a state: items sorted by variable name."""
    return tuple(sorted(state.items()))


def _result(status, depth, visited, trace, counterexample, error):
    return {
        "status": status,
        "depth": depth,
        "visited": visited,
        "trace": trace,
        "counterexample": counterexample,
        "error": error,
    }


def _error_result(code, message, depth, visited, trace):
    return _result(
        ERROR,
        depth,
        visited,
        trace,
        None,
        {"code": code, "message": message},
    )


def check(model: Model, bound: int) -> dict:
    """Run bounded BFS up to *bound* layers and return a result dict."""
    init = dict(sorted(model.init.items()))
    visited = {canonical(init)}
    # Queue entries: (state, path of states from init, transition names taken).
    queue = deque([(init, [init], [])])
    max_depth = 0

    while queue:
        state, path, transitions_taken = queue.popleft()
        depth = len(path) - 1
        max_depth = max(max_depth, depth)

        try:
            holds = evaluate(model.invariant, state)
        except UndefinedVariableError as exc:
            return _error_result(E_READ, str(exc), depth, len(visited), path)
        except EvaluationError as exc:
            return _error_result("E_EVAL", str(exc), depth, len(visited), path)
        if not holds:
            return _result(
                VIOLATION,
                depth,
                len(visited),
                path,
                {"transitions": transitions_taken, "states": path},
                None,
            )

        if depth >= bound:
            continue

        for transition in model.transitions:
            try:
                enabled = evaluate(transition.guard, state)
            except UndefinedVariableError as exc:
                return _error_result(E_READ, str(exc), depth, len(visited), path)
            except EvaluationError:
                continue  # guard cannot be evaluated: transition disabled
            if not enabled:
                continue
            successor = dict(state)
            disabled = False
            try:
                new_values = {
                    var: evaluate(expr, state) for var, expr in transition.assign
                }
            except UndefinedVariableError as exc:
                return _error_result(E_READ, str(exc), depth, len(visited), path)
            except EvaluationError:
                continue  # assignment cannot be evaluated: transition disabled
            for value in new_values.values():
                if (
                    isinstance(value, bool)
                    or not isinstance(value, int)
                    or not (DOMAIN_MIN <= value <= DOMAIN_MAX)
                ):
                    disabled = True  # out of domain: transition disabled, not a crash
                    break
            if disabled:
                continue
            successor.update(new_values)
            successor = dict(sorted(successor.items()))
            key = canonical(successor)
            if key in visited:
                continue  # never enqueue the same state twice
            visited.add(key)
            queue.append(
                (
                    successor,
                    path + [successor],
                    transitions_taken + [transition.name],
                )
            )

    # Bound reached (or state space exhausted) without a violation: this is
    # only a *bounded* result, never a proof of global safety.
    return _result(SAFE_BOUNDED, max_depth, len(visited), [], None, None)
