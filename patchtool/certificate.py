"""Optimality certificates based on assignment-problem duality.

The certificate carries the full assignment on the square cost model plus
dual potentials ``u`` (rows) and ``v`` (columns).  A verifier checks, in
polynomial time and *without running any optimiser*:

1. the assignment is a permutation and its matched cost equals the claimed
   total;
2. dual feasibility: ``u[i] + v[j] <= cost[i][j]`` for every cell;
3. complementary slackness: equality on every matched cell;
4. ``sum(u) + sum(v)`` equals the claimed total.

By weak duality any matching costs at least ``sum(u) + sum(v)``, so the
carried matching is optimal.  The verifier additionally derives the
operation sequence from the assignment and compares it with the patch.
"""
from __future__ import annotations

from .matching import CostModel, pair_op


class CertificateError(ValueError):
    """Raised when a certificate fails verification."""


def build_certificate(model, assignment, u, v, cost, src_hash, dst_hash):
    return {
        "version": 1,
        "src_hash": src_hash,
        "dst_hash": dst_hash,
        "cost": cost,
        "rows": model.row_labels(),
        "cols": model.col_labels(),
        "assignment": list(assignment),
        "u": list(u),
        "v": list(v),
    }


def ops_from_assignment(model, assignment):
    """Derive the normalised operation sequence from a full assignment."""
    n, m = model.n, model.m
    ops = []
    for i in range(n):
        c = assignment[i]
        if c < m:
            op = pair_op(model.src[i][0], model.src[i][1],
                         model.dst[c][0], model.dst[c][1])
            if op is not None:
                ops.append(op)
        elif c == m + i:
            ops.append(("delete", model.src[i][0]))
        else:
            raise CertificateError(f"row {i} matched to a foreign dummy column")
    for j in range(m):
        c = assignment[n + j]
        if c == j:
            ops.append(("add", model.dst[j][0]))
        elif c < m:
            raise CertificateError(f"add-dummy row {n + j} matched to a real column")
    return sorted(ops)


def verify_certificate(src_tree, dst_tree, certificate, expected_ops=None):
    """Verify an optimality certificate; raises :class:`CertificateError`.

    Runs no optimiser: only recomputes the cost matrix and checks the
    primal/dual conditions above.
    """
    def fail(msg):
        raise CertificateError(msg)

    cert = certificate
    if not isinstance(cert, dict) or cert.get("version") != 1:
        fail("unsupported certificate")
    if cert.get("src_hash") != src_tree.tree_hash():
        fail("source tree hash mismatch")
    if cert.get("dst_hash") != dst_tree.tree_hash():
        fail("destination tree hash mismatch")

    src_files = sorted(src_tree.files.items())
    dst_files = sorted(dst_tree.files.items())
    model = CostModel(src_files, dst_files)
    if cert.get("rows") != model.row_labels():
        fail("row labels mismatch")
    if cert.get("cols") != model.col_labels():
        fail("column labels mismatch")

    size = model.size
    assignment = cert.get("assignment")
    u = cert.get("u")
    v = cert.get("v")
    cost = cert.get("cost")
    if not (isinstance(assignment, list) and len(assignment) == size
            and all(isinstance(x, int) for x in assignment)
            and sorted(assignment) == list(range(size))):
        fail("assignment is not a permutation")
    if not (isinstance(u, list) and len(u) == size
            and all(isinstance(x, int) for x in u)):
        fail("invalid row potentials")
    if not (isinstance(v, list) and len(v) == size
            and all(isinstance(x, int) for x in v)):
        fail("invalid column potentials")
    if not isinstance(cost, int):
        fail("invalid cost")

    M = model.matrix
    matched = sum(M[i][assignment[i]] for i in range(size))
    if matched != cost:
        fail(f"matched cost {matched} != claimed cost {cost}")
    for i in range(size):
        ui = u[i]
        row = M[i]
        for j in range(size):
            if ui + v[j] > row[j]:
                fail(f"dual infeasible at ({i}, {j})")
    for i in range(size):
        j = assignment[i]
        if u[i] + v[j] != M[i][j]:
            fail(f"complementary slackness violated at row {i}")
    if sum(u) + sum(v) != cost:
        fail("dual objective does not match claimed cost")

    if expected_ops is not None:
        derived = ops_from_assignment(model, assignment)
        if derived != list(expected_ops):
            fail("operation sequence does not match the certified assignment")
    return True
