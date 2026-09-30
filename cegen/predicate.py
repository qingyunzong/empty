"""Safe-ish predicate compilation and evaluation."""
from __future__ import annotations

import builtins

from .errors import PolicyError

SAFE_NAMES = {
    name: getattr(builtins, name)
    for name in ("abs", "all", "any", "len", "max", "min", "sorted", "sum")
}


def compile_predicate(expr):
    """Compile a predicate expression; PolicyError on invalid input."""
    if not isinstance(expr, str) or not expr.strip():
        raise PolicyError("predicate must be a non-empty string")
    try:
        return compile(expr, "<predicate>", "eval")
    except (SyntaxError, ValueError) as exc:
        raise PolicyError(f"invalid predicate: {exc}") from exc


def evaluate(code, env):
    """Evaluate a compiled predicate. Any exception propagates to the caller,
    which reports INVALID_INPUT (never a counterexample)."""
    namespace = dict(SAFE_NAMES)
    namespace.update(env)
    return bool(eval(code, {"__builtins__": {}}, namespace))
