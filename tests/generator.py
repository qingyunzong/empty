"""Exhaustive generator of candidate expressions with token length <= N.

Candidates are produced grammar-directedly (atoms, unary, binary, ternary,
parenthesized groups, calls, subscripts) over a small token alphabet, then
deduplicated and filtered by the *reference* parser, so validity is decided
independently of the Pratt parser under test.
"""

from prattx.lexer import lex

ATOMS = ("1", "x")
UNARY_OPS = ("-", "!")
BINARY_OPS = ("+", "*", "**", "==", "&&", "=")


def _exact(n):
    """Yield candidate strings whose intended token count is exactly n."""
    if n == 1:
        yield from ATOMS
    if n >= 2:
        for op in UNARY_OPS:
            for inner in _exact(n - 1):
                yield op + inner
    if n >= 3:
        for left_n in range(1, n - 1):
            right_n = n - 1 - left_n
            if right_n < 1:
                continue
            for left in _exact(left_n):
                for op in BINARY_OPS:
                    for right in _exact(right_n):
                        yield left + op + right
        for inner in _exact(n - 2):
            yield "(" + inner + ")"
        for callee in _exact(n - 2):
            yield callee + "()"
        for callee_n in range(1, n - 2):
            arg_n = n - 2 - callee_n
            if arg_n < 1:
                continue
            for callee in _exact(callee_n):
                for arg in _exact(arg_n):
                    yield callee + "(" + arg + ")"
                    yield callee + "[" + arg + "]"
        for cond_n in range(1, n - 2):
            for then_n in range(1, n - 1 - cond_n):
                else_n = n - 2 - cond_n - then_n
                if else_n < 1:
                    continue
                for cond in _exact(cond_n):
                    for then in _exact(then_n):
                        for otherwise in _exact(else_n):
                            yield cond + "?" + then + ":" + otherwise


def token_count(src):
    return len(lex(src)) - 1  # exclude EOF


def generate(max_tokens=5):
    """Yield unique candidate strings with real token count <= max_tokens."""
    seen = set()
    for n in range(1, max_tokens + 1):
        for src in _exact(n):
            if src in seen:
                continue
            seen.add(src)
            if token_count(src) <= max_tokens:
                yield src
