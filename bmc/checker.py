"""Breadth-first bounded model checking.

Semantics:
- States are normalized as tuples of (name, value) sorted by variable name.
- A transition is enabled only when its guard holds and every assigned
  value stays inside the domain; otherwise it is disabled (never an error).
- States are explored in BFS layer order; the first state violating the
  invariant yields the shortest counterexample.
- Reaching the bound without a violation yields SAFE_BOUNDED (not a
  proof of global safety).
- A state already visited is never enqueued again.
"""

from collections import deque

from .expr import EvalError, evaluate
from .model import MAX_VALUE, MIN_VALUE

STATUS_SAFE = "SAFE_BOUNDED"
STATUS_VIOLATION = "VIOLATION"
STATUS_ERROR = "ERROR"


def normalize(state_dict):
    """Canonical hashable form of a state, sorted by variable name."""
    return tuple(sorted(state_dict.items()))


def check(model, bound):
    """Run BFS up to `bound` steps. Returns a result dict."""
    if bound < 0:
        raise ValueError("bound must be non-negative")

    init = normalize(model.init)
    visited = {init}
    queue = deque([(init, [])])
    max_depth = 0

    try:
        if not _holds(model.invariant, init):
            return _result(STATUS_VIOLATION, 0, visited, [init], [])
        while queue:
            state, path = queue.popleft()
            depth = len(path)
            max_depth = max(max_depth, depth)
            if depth >= bound:
                continue
            for transition in model.transitions:
                successor = _fire(transition, state)
                if successor is None or successor in visited:
                    continue
                next_path = path + [(transition.name, successor)]
                if not _holds(model.invariant, successor):
                    visited.add(successor)
                    trace = [init] + [s for _, s in next_path]
                    steps = [name for name, _ in next_path]
                    return _result(
                        STATUS_VIOLATION, depth + 1, visited, trace, steps
                    )
                visited.add(successor)
                queue.append((successor, next_path))
    except EvalError as exc:
        return {
            "status": STATUS_ERROR,
            "depth": None,
            "visited": len(visited),
            "trace": [],
            "counterexample": None,
            "error": {"code": exc.code, "message": str(exc)},
        }

    return _result(STATUS_SAFE, max_depth, visited, [], None)


def _result(status, depth, visited, trace, steps):
    return {
        "status": status,
        "depth": depth,
        "visited": len(visited),
        "trace": [dict(state) for state in trace],
        "counterexample": steps,
        "error": None,
    }


def _holds(invariant, state):
    return bool(evaluate(invariant, dict(state)))


def _fire(transition, state):
    """Return the successor state, or None if the transition is disabled."""
    state_dict = dict(state)
    if not evaluate(transition.guard, state_dict):
        return None
    updates = {}
    for target, expr in transition.assign.items():
        value = evaluate(expr, state_dict)
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        if not MIN_VALUE <= value <= MAX_VALUE:
            return None
        updates[target] = value
    if not updates:
        return None
    successor = dict(state_dict)
    successor.update(updates)
    return normalize(successor)
