"""Exact integer k-th root floor with verifiable comparison evidence.

All power comparisons use truncated (capped) exponentiation so that no
uselessly large intermediate integers are ever produced: when checking
``r**k <= n`` we never materialize a value larger than ``|n| + 1``.
"""


def pow_cap(base, exp, cap):
    """Return ``base**exp`` saturated to the window ``[-(cap+1), cap+1]``.

    The result is exact whenever ``|base**exp| <= cap``; otherwise the
    saturation value ``cap+1`` (or ``-(cap+1)``) preserves the outcome of
    any comparison against integers inside ``[-cap, cap]``.  Intermediate
    products stay below roughly ``(cap+1)**2`` no matter how astronomically
    large the true power would be.
    """
    base = int(base)
    exp = int(exp)
    cap = int(cap)
    if exp < 0:
        raise ValueError("exp must be non-negative")
    if cap < 0:
        raise ValueError("cap must be non-negative")
    if exp == 0:
        return 1
    limit = cap + 1
    negative = base < 0 and (exp & 1)
    b = abs(base)
    result = 1
    e = exp
    while e:
        if e & 1:
            result *= b
            if result > limit:
                result = limit
        e >>= 1
        if e:
            b *= b
            if b > limit:
                b = limit
    return -result if negative else result


def int_kth_root_floor(n, k):
    """Return the integer ``r`` with ``r**k <= n < (r+1)**k``.

    For negative ``n`` only odd ``k`` is defined (real odd root); the floor
    of the (negative) real k-th root is returned, e.g. for ``n=-9, k=3``
    the result is ``-3`` because ``(-3)**3 = -27 <= -9 < -8 = (-2)**3``.
    """
    n = int(n)
    k = int(k)
    if k < 1:
        raise ValueError("k must be a positive integer")
    if k == 1:
        return n
    if n < 0:
        if k % 2 == 0:
            raise ValueError("even root of a negative integer is not real")
        s = int_kth_root_floor(-n, k)
        # s**k <= -n exactly, so the equality test is exact.
        return -s if s ** k == -n else -(s + 1)
    # Invariant: lo**k <= n < hi**k.
    lo = 0
    hi = 1 << ((n.bit_length() + k - 1) // k) if n else 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if pow_cap(mid, k, n) <= n:
            lo = mid
        else:
            hi = mid
    return lo


def root_evidence(n, k):
    """Compute the k-th root floor and return a verifiable evidence dict."""
    n = int(n)
    k = int(k)
    return {"n": n, "k": k, "r": int_kth_root_floor(n, k)}


def verify_root_evidence(evidence):
    """Verify ``{"n", "k", "r"}``: ``r**k <= n < (r+1)**k``.

    Returns True only when the claim holds exactly.  Any tampering with
    ``n``, ``k`` or ``r`` (or malformed input) is rejected.  The checks use
    capped exponentiation, so verification is cheap even for huge ``k``.
    """
    try:
        n = evidence["n"]
        k = evidence["k"]
        r = evidence["r"]
    except (KeyError, TypeError):
        return False
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in (n, k, r)):
        return False
    if k < 1:
        return False
    if n < 0 and k % 2 == 0:
        return False
    cap = abs(n)
    return pow_cap(r, k, cap) <= n < pow_cap(r + 1, k, cap)
