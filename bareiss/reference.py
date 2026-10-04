"""Independent Fraction-based Gaussian elimination.

Used only to cross-check the Bareiss engine on small matrices.  Shares no
code with bareiss.core so the two implementations can catch each other's
mistakes.
"""
from __future__ import annotations

from fractions import Fraction


def _to_fraction(matrix):
    return [[Fraction(v) for v in row] for row in matrix]


def rref(matrix):
    """Reduced row echelon form; returns (R, pivot_columns, row_swaps)."""
    A = _to_fraction(matrix)
    m = len(A)
    n = len(A[0]) if m else 0
    pivots = []
    swaps = 0
    row = 0
    for col in range(n):
        if row == m:
            break
        piv = next((i for i in range(row, m) if A[i][col] != 0), None)
        if piv is None:
            continue
        if piv != row:
            A[row], A[piv] = A[piv], A[row]
            swaps += 1
        scale = A[row][col]
        A[row] = [v / scale for v in A[row]]
        for i in range(m):
            if i != row and A[i][col] != 0:
                factor = A[i][col]
                A[i] = [a - factor * b for a, b in zip(A[i], A[row])]
        pivots.append(col)
        row += 1
    return A, pivots, swaps


def rank(matrix):
    return len(rref(matrix)[1])


def determinant(matrix):
    n = len(matrix)
    if any(len(row) != n for row in matrix):
        raise ValueError("determinant requires a square matrix")
    A = _to_fraction(matrix)
    det = Fraction(1)
    for col in range(n):
        piv = next((i for i in range(col, n) if A[i][col] != 0), None)
        if piv is None:
            return 0
        if piv != col:
            A[col], A[piv] = A[piv], A[col]
            det = -det
        det *= A[col][col]
        for i in range(col + 1, n):
            factor = A[i][col] / A[col][col]
            for j in range(col, n):
                A[i][j] -= factor * A[col][j]
    result = int(det)
    return result


def solve(A, b):
    """Return (status, particular, null_basis) with Fraction entries."""
    m = len(A)
    n = len(A[0]) if m else 0
    aug = [row + [Fraction(bi)] for row, bi in zip(_to_fraction(A), b)]
    R, pivots, _ = rref(aug)
    if n in pivots:
        return "inconsistent", None, None
    particular = [Fraction(0)] * n
    for i, col in enumerate(pivots):
        particular[col] = R[i][n]
    free = [c for c in range(n) if c not in pivots]
    basis = []
    for f in free:
        v = [Fraction(0)] * n
        v[f] = Fraction(1)
        for i, col in enumerate(pivots):
            v[col] = -R[i][f]
        basis.append(v)
    status = "unique" if not free else "infinite"
    return status, particular, basis
