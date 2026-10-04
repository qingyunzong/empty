"""Exact integer k-th roots with verifiable comparison evidence.

``integer_kth_root(n, k)`` returns r together with an evidence record that
anyone can re-check using only integer arithmetic:

    r**k <= n < (r+1)**k

Power comparisons during the search use upper-bound truncation
(``capped_pow_leq``): partial products are abandoned as soon as they exceed
the bound, so no uselessly large intermediate powers are ever formed.

For odd k the definition extends to negative n (the floor root, e.g. the
integer cube root of -9 is -3 because (-3)**3 <= -9 < (-2)**3).
"""

from dataclasses import dataclass


def capped_pow_leq(base, exp, cap):
    """Return True iff ``base**exp <= cap`` for ``base >= 0``.

    The product is truncated as soon as it exceeds ``cap``; intermediate
    values never grow beyond ``cap * base``.
    """
    if base < 0:
        raise ValueError("capped_pow_leq requires a non-negative base")
    if exp < 0:
        raise ValueError("exponent must be non-negative")
    result = 1
    for _ in range(exp):
        result *= base
        if result > cap:
            return False
    return True


@dataclass(frozen=True)
class IntRootEvidence:
    """Verifiable witness for r**k <= n < (r+1)**k."""

    n: int
    k: int
    r: int
    r_pow_k: int
    r_plus_1_pow_k: int

    def to_dict(self):
        return {
            "n": str(self.n),
            "k": str(self.k),
            "r": str(self.r),
            "r_pow_k": str(self.r_pow_k),
            "r_plus_1_pow_k": str(self.r_plus_1_pow_k),
        }

    @classmethod
    def from_dict(cls, data):
        def as_int(v):
            if isinstance(v, bool):
                raise TypeError("boolean is not an integer")
            if isinstance(v, int):
                return v
            if isinstance(v, str):
                return int(v)
            raise TypeError(f"not an integer: {v!r}")

        return cls(
            n=as_int(data["n"]),
            k=as_int(data["k"]),
            r=as_int(data["r"]),
            r_pow_k=as_int(data["r_pow_k"]),
            r_plus_1_pow_k=as_int(data["r_plus_1_pow_k"]),
        )


def integer_kth_root(n, k):
    """Return IntRootEvidence with r = floor(n ** (1/k)).

    Requires k >= 1, and n >= 0 unless k is odd.
    """
    if not isinstance(n, int) or isinstance(n, bool):
        raise TypeError("n must be an integer")
    if not isinstance(k, int) or isinstance(k, bool) or k < 1:
        raise ValueError("k must be a positive integer")
    if n < 0:
        if k % 2 == 0:
            raise ValueError("even k-th root of a negative integer")
        s = integer_kth_root(-n, k).r
        r = -s if s**k == -n else -(s + 1)
        return IntRootEvidence(n=n, k=k, r=r, r_pow_k=r**k,
                               r_plus_1_pow_k=(r + 1) ** k)
    lo = 0
    hi = 1 << max(1, -(-n.bit_length() // k))
    while capped_pow_leq(hi, k, n):
        hi <<= 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if capped_pow_leq(mid, k, n):
            lo = mid
        else:
            hi = mid
    return IntRootEvidence(n=n, k=k, r=lo, r_pow_k=lo**k,
                           r_plus_1_pow_k=(lo + 1) ** k)


def verify_introot_evidence(ev):
    """Re-check an evidence record with pure integer arithmetic.

    Returns True only if the stored powers are exactly r**k and (r+1)**k
    and the claimed inequality r**k <= n < (r+1)**k holds. Any tampering
    makes the check fail.
    """
    try:
        n, k, r = ev.n, ev.k, ev.r
        for v in (n, k, r, ev.r_pow_k, ev.r_plus_1_pow_k):
            if not isinstance(v, int) or isinstance(v, bool):
                return False
        if k < 1:
            return False
        if n < 0 and k % 2 == 0:
            return False
        if ev.r_pow_k != r**k:
            return False
        if ev.r_plus_1_pow_k != (r + 1) ** k:
            return False
        return ev.r_pow_k <= n < ev.r_plus_1_pow_k
    except (AttributeError, TypeError):
        return False
