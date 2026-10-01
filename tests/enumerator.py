"""Enumerate every syntactically legal expression of at most N tokens.

Length is measured in tokens. The grammar covered: integer/identifier atoms,
prefix + - !, all binary operators, the ?: conditional, calls with 0/1/2
arguments, indexing, and grouping parentheses.
"""

ATOMS = ("1", "x")
UNARY_OPS = ("+", "-", "!")
BINARY_OPS = (
    "+", "-", "*", "/", "%", "**",
    "==", "!=", "<", "<=", ">", ">=",
    "&&", "||", "=",
)


def generate(max_len=5):
    """Return the sorted list of all legal expressions of <= max_len tokens."""
    by_len = [set() for _ in range(max_len + 1)]
    by_len[1] = set(ATOMS)
    for n in range(2, max_len + 1):
        out = by_len[n]
        # prefix unary: 1 + len(operand)
        for op in UNARY_OPS:
            for operand in by_len[n - 1]:
                out.add(op + operand)
        # binary: len(a) + 1 + len(b)
        for la in range(1, n - 1):
            lb = n - 1 - la
            if lb < 1:
                continue
            for a in by_len[la]:
                for b in by_len[lb]:
                    for op in BINARY_OPS:
                        out.add(a + op + b)
        # ternary: len(c) + 1 + len(t) + 1 + len(f)
        for lc in range(1, n - 3):
            for lt in range(1, n - 2 - lc):
                lf = n - 2 - lc - lt
                if lf < 1:
                    continue
                for c in by_len[lc]:
                    for t in by_len[lt]:
                        for f in by_len[lf]:
                            out.add(c + "?" + t + ":" + f)
        # grouping parentheses: 2 + len(inner)
        if n >= 3:
            for inner in by_len[n - 2]:
                out.add("(" + inner + ")")
        # call with zero args: len(f) + 2
        if n >= 3:
            for f in by_len[n - 2]:
                out.add(f + "()")
        # call with one arg / index: len(f) + 2 + len(arg)
        for lf in range(1, n - 2):
            la = n - 2 - lf
            if la < 1:
                continue
            for f in by_len[lf]:
                for a in by_len[la]:
                    out.add(f + "(" + a + ")")
                    out.add(f + "[" + a + "]")
        # call with two args: len(f) + 3 + len(a1) + len(a2)
        for lf in range(1, n - 4):
            for l1 in range(1, n - 3 - lf):
                l2 = n - 3 - lf - l1
                if l2 < 1:
                    continue
                for f in by_len[lf]:
                    for a1 in by_len[l1]:
                        for a2 in by_len[l2]:
                            out.add(f + "(" + a1 + "," + a2 + ")")
    result = set()
    for n in range(1, max_len + 1):
        result |= by_len[n]
    return sorted(result)
