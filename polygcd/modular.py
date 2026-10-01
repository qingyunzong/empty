"""Polynomial arithmetic over prime fields and Chinese remaindering."""

from .polynomial import trim


def mod_poly(p, m):
    return trim(tuple(c % m for c in p))


def _rem_mod(a, b, p):
    rem = list(a)
    inv_lc = pow(b[-1], -1, p)
    while rem and len(rem) >= len(b):
        c = rem[-1] * inv_lc % p
        shift = len(rem) - len(b)
        for j in range(len(b)):
            rem[shift + j] = (rem[shift + j] - c * b[j]) % p
        while rem and rem[-1] == 0:
            rem.pop()
    return tuple(rem)


def gcd_mod_p(f, g, p):
    """Monic gcd of f and g over GF(p); () if both reduce to zero."""
    a = mod_poly(f, p)
    b = mod_poly(g, p)
    while b:
        a, b = b, _rem_mod(a, b, p)
    if not a:
        return ()
    inv = pow(a[-1], -1, p)
    return trim(tuple(c * inv % p for c in a))


def crt_pair(a1, m1, a2, m2):
    """Combine x == a1 (mod m1), x == a2 (mod m2) for coprime m1, m2."""
    t = (a2 - a1) % m2
    t = t * pow(m1 % m2, -1, m2) % m2
    return a1 + m1 * t


def crt_polys(residues, moduli):
    """Combine coefficientwise. Returns (poly, M) with residues in [0, M)."""
    if not residues:
        raise ValueError("no congruences to combine")
    acc = list(residues[0])
    M = moduli[0]
    for r, m in zip(residues[1:], moduli[1:]):
        n = max(len(acc), len(r))
        combined = []
        for i in range(n):
            a1 = acc[i] if i < len(acc) else 0
            a2 = r[i] if i < len(r) else 0
            combined.append(crt_pair(a1, M, a2, m))
        M *= m
        acc = combined
    return trim(acc), M
