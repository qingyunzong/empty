"""Independent verification by plain exact matrix multiplication.

Nothing here touches the Bareiss internals; every check is a direct
evaluation of the defining equations with Fraction arithmetic.
"""
from __future__ import annotations

from fractions import Fraction


def matvec(A, x):
    return [sum(Fraction(a) * Fraction(xj) for a, xj in zip(row, x))
            for row in A]


def verify_solution(A, x, b):
    return matvec(A, x) == [Fraction(v) for v in b]


def verify_null_vector(A, v):
    return all(value == 0 for value in matvec(A, v))


def verify_certificate(A, b, y):
    """Check y^T A = 0 and y^T b != 0."""
    n = len(A[0]) if A else 0
    ytA = [sum(Fraction(y[i]) * A[i][j] for i in range(len(y)))
           for j in range(n)]
    ytb = sum(Fraction(y[i]) * Fraction(b[i]) for i in range(len(y)))
    return all(v == 0 for v in ytA) and ytb != 0


def fraction_rank(rows):
    if not rows:
        return 0
    A = [[Fraction(v) for v in row] for row in rows]
    m, n = len(A), len(A[0])
    rank = 0
    for col in range(n):
        if rank == m:
            break
        piv = next((i for i in range(rank, m) if A[i][col] != 0), None)
        if piv is None:
            continue
        A[rank], A[piv] = A[piv], A[rank]
        scale = A[rank][col]
        A[rank] = [v / scale for v in A[rank]]
        for i in range(m):
            if i != rank and A[i][col] != 0:
                factor = A[i][col]
                A[i] = [a - factor * b for a, b in zip(A[i], A[rank])]
        rank += 1
    return rank


def verify_solutions(A, rhs, solutions, rank):
    """Verify every solve result independently; returns a list of dicts."""
    n = len(A[0]) if A else 0
    checks = []
    for b, sol in zip(rhs, solutions):
        entry = {"status": sol["status"]}
        if sol["status"] == "inconsistent":
            entry["certificate_valid"] = verify_certificate(
                A, b, sol["certificate"])
        else:
            entry["particular_valid"] = verify_solution(
                A, sol["particular"], b)
            basis = sol["null_basis"]
            entry["null_basis_valid"] = all(
                verify_null_vector(A, v) for v in basis)
            entry["null_basis_dim_ok"] = len(basis) == n - rank
            entry["null_basis_independent"] = (
                fraction_rank(basis) == len(basis))
        checks.append(entry)
    return checks
