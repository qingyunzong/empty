"""Verified interval Newton method over exact rational arithmetic.

Isolates every real root of a rational-coefficient polynomial inside a
rational interval [a, b] and returns rational interval enclosures, each
strictly narrower than eps and each containing exactly one real root.

CLI:
    python interval_newton.py COEFFS_FILE INTERVAL EPS

COEFFS_FILE  whitespace-separated rational coefficients, highest degree
             first ('#' starts a comment).  Example for 2x^2 - 3/4 x + 1:
                 2  -3/4  1
INTERVAL     search interval, e.g. "[-1,2]" or "-1,2".
EPS          positive rational, e.g. "1e-30" or "1/1000000".

Output: JSON array of [lo, hi] pairs (exact rational strings) on stdout.

Exit codes: 0 success, 1 invalid input, 4 multiple root inside [a, b].
"""

from __future__ import annotations

import argparse
import json
import sys
from fractions import Fraction


class MultipleRootError(Exception):
    """The polynomial has a multiple real root inside the search interval."""


# --------------------------------------------------------------------------
# Exact polynomial arithmetic over Fraction (coefficients, highest degree first)
# --------------------------------------------------------------------------

def trim(c):
    i = 0
    while i < len(c) - 1 and c[i] == 0:
        i += 1
    return c[i:]


def poly_eval(coeffs, x):
    r = Fraction(0)
    for c in coeffs:
        r = r * x + c
    return r


def poly_derivative(coeffs):
    n = len(coeffs) - 1
    d = trim([c * (n - i) for i, c in enumerate(coeffs[:-1])])
    return d if d else [Fraction(0)]


def poly_divmod(a, b):
    a, b = trim(a), trim(b)
    if not any(b):
        raise ZeroDivisionError("polynomial division by zero")
    if len(a) < len(b):
        return [Fraction(0)], a
    q = [Fraction(0)] * (len(a) - len(b) + 1)
    r = list(a)
    for i in range(len(q)):
        c = r[i] / b[0]
        q[i] = c
        for j in range(len(b)):
            r[i + j] -= c * b[j]
    return q, trim(r[len(q):])


def poly_gcd(a, b):
    a, b = trim(a), trim(b)
    while any(b):
        _, r = poly_divmod(a, b)
        a, b = b, r
    lc = a[0]
    return [c / lc for c in a]


# --------------------------------------------------------------------------
# Exact rational interval arithmetic
# --------------------------------------------------------------------------

def imul(x, y):
    p = (x[0] * y[0], x[0] * y[1], x[1] * y[0], x[1] * y[1])
    return (min(p), max(p))


def poly_eval_interval(coeffs, X):
    lo = hi = Fraction(0)
    for c in coeffs:
        lo, hi = imul((lo, hi), X)
        lo += c
        hi += c
    return (lo, hi)


# --------------------------------------------------------------------------
# Core: interval Newton iteration with bisection fallback
# --------------------------------------------------------------------------

def _bisect(stack, lo, hi):
    mid = (lo + hi) / 2
    stack.append((lo, mid))
    stack.append((mid, hi))


def _isolate(coeffs, dcoeffs, a, b, eps):
    """Return interior-disjoint verified intervals, each of width < eps and
    each certified (sign change + nonzero derivative enclosure) to contain
    exactly one real root.  Requires all roots of `coeffs` in [a, b] simple."""
    found = []
    stack = [(a, b)]
    while stack:
        lo, hi = stack.pop()
        fx = poly_eval_interval(coeffs, (lo, hi))
        if fx[0] > 0 or fx[1] < 0:
            continue
        width = hi - lo
        if width < eps:
            flo = poly_eval(coeffs, lo)
            fhi = poly_eval(coeffs, hi)
            if flo * fhi > 0:
                continue
            dfx = poly_eval_interval(dcoeffs, (lo, hi))
            if dfx[0] > 0 or dfx[1] < 0:
                found.append((lo, hi))
                continue
            _bisect(stack, lo, hi)
            continue
        dfx = poly_eval_interval(dcoeffs, (lo, hi))
        if dfx[0] <= 0 <= dfx[1]:
            _bisect(stack, lo, hi)
            continue
        m = (lo + hi) / 2
        fm = poly_eval(coeffs, m)
        q = (min(fm / dfx[0], fm / dfx[1]), max(fm / dfx[0], fm / dfx[1]))
        nlo = max(m - q[1], lo)
        nhi = min(m - q[0], hi)
        if nlo > nhi:
            continue
        if nhi - nlo <= width * Fraction(9, 10):
            stack.append((nlo, nhi))
        else:
            _bisect(stack, lo, hi)
    return found


def _dedupe(found, coeffs):
    """Merge intervals that touch at a shared endpoint which is itself a
    root (both halves of a bisected interval then certify the same root)."""
    out = []
    for lo, hi in sorted(found):
        if out and lo == out[-1][1] and poly_eval(coeffs, lo) == 0:
            out[-1] = (lo, lo)
        else:
            out.append((lo, hi))
    return out


def _check_simple_roots(coeffs, a, b, eps):
    g = poly_gcd(coeffs, poly_derivative(coeffs))
    if len(g) <= 1:
        return
    h = trim(poly_divmod(g, poly_gcd(g, poly_derivative(g)))[0])
    if len(h) <= 1:
        return
    if _isolate(h, poly_derivative(h), a, b, eps):
        raise MultipleRootError(
            "polynomial has a multiple real root inside [{}, {}]".format(a, b))


def find_roots(coeffs, a, b, eps):
    """Isolate all real roots of the polynomial in [a, b].

    Returns a sorted list of (lo, hi) Fraction pairs, each of width < eps
    and each containing exactly one real root.  Raises MultipleRootError if
    the polynomial has a multiple real root inside [a, b]."""
    coeffs = trim([Fraction(c) for c in coeffs])
    a, b, eps = Fraction(a), Fraction(b), Fraction(eps)
    if not any(coeffs):
        raise ValueError("zero polynomial has no isolatable roots")
    if a > b:
        raise ValueError("empty interval: a > b")
    if eps <= 0:
        raise ValueError("eps must be positive")
    if len(coeffs) == 1:
        return []
    _check_simple_roots(coeffs, a, b, eps)
    return _dedupe(_isolate(coeffs, poly_derivative(coeffs), a, b, eps), coeffs)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _parse_interval(text):
    parts = text.strip().strip("[]()").split(",")
    if len(parts) != 2:
        raise ValueError("interval must look like '[a,b]', got %r" % text)
    return Fraction(parts[0].strip()), Fraction(parts[1].strip())


def _read_coeffs(path):
    tokens = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            tokens.extend(line.split("#", 1)[0].split())
    if not tokens:
        raise ValueError("coefficient file is empty")
    return [Fraction(tok) for tok in tokens]


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="interval_newton",
        description="Verified interval Newton root isolation (exact rational "
                    "arithmetic). Prints a JSON array of [lo, hi] intervals, "
                    "each narrower than EPS and containing exactly one root.")
    parser.add_argument("coeff_file",
                        help="rational coefficients, highest degree first")
    parser.add_argument("interval", help="search interval, e.g. '[-1,2]'")
    parser.add_argument("eps", help="positive rational, e.g. '1e-30'")
    args = parser.parse_args(argv)
    try:
        coeffs = _read_coeffs(args.coeff_file)
        a, b = _parse_interval(args.interval)
        eps = Fraction(args.eps)
        roots = find_roots(coeffs, a, b, eps)
    except MultipleRootError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 4
    except (ValueError, OSError, ZeroDivisionError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    json.dump([[str(lo), str(hi)] for lo, hi in roots], sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
