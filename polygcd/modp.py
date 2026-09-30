"""Polynomial arithmetic over the prime field GF(p)."""

from .poly import trim


def reduce_mod(a, p):
    return trim([c % p for c in a])


def _inv(x, p):
    return pow(x % p, p - 2, p)


def divmod_p(a, b, p):
    """(quotient, remainder) of a / b over GF(p)."""
    if not b:
        raise ZeroDivisionError("polynomial division by zero")
    a = [c % p for c in a]
    while a and a[-1] == 0:
        a.pop()
    if len(a) < len(b):
        return [], a
    q = [0] * (len(a) - len(b) + 1)
    inv = _inv(b[-1], p)
    while len(a) >= len(b) and a:
        k = len(a) - len(b)
        c = a[-1] * inv % p
        q[k] = c
        if c:
            for j in range(len(b)):
                a[k + j] = (a[k + j] - c * b[j]) % p
        while a and a[-1] == 0:
            a.pop()
    return trim(q), a


def monic_p(a, p):
    if not a:
        return []
    inv = _inv(a[-1], p)
    return [(c * inv) % p for c in a]


def gcd_mod_p(f, g, p):
    """Monic GCD of f and g over GF(p).  Both must be nonzero mod p."""
    a = reduce_mod(f, p)
    b = reduce_mod(g, p)
    if not a or not b:
        raise ValueError("polynomial vanishes modulo p")
    while b:
        _, r = divmod_p(a, b, p)
        a, b = b, r
    return monic_p(a, p)


def is_prime(n):
    """Deterministic Miller-Rabin for n < 2**64, trial division beyond."""
    if n < 2:
        return False
    for q in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % q == 0:
            return n == q
    d = n - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1
    # Deterministic bases for n < 2**64.
    for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if a >= n:
            continue
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


def prev_prime(n):
    """Largest prime strictly below n."""
    c = n - 1
    if c <= 2:
        return 2 if n > 2 else None
    if c % 2 == 0:
        c -= 1
    while c > 2 and not is_prime(c):
        c -= 2
    return c if c > 2 else 2
