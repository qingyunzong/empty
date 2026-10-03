"""Minimum-cost bipartite matching between source and target files.

The pairing is decided by an exact assignment solver (Hungarian
algorithm), never by greedy same-hash pairing.  Ties between matchings
of equal cost are broken by the lexicographic order of the normalized
operation sequence (the sorted tuple of canonical operation encodings).

The solver also emits a certificate: dual potentials of the assignment
problem.  A verifier can check optimality (and the tie-break) from the
potentials alone, without running any optimizer.
"""
from __future__ import annotations

from .costs import add_cost, delete_cost, pair_cost


class CertificateError(ValueError):
    """Raised when a matching certificate fails verification."""


def pair_operation(src_path, src_lines, dst_path, dst_lines):
    """Canonical operation encoding for a matched pair."""
    if src_path == dst_path:
        if list(src_lines) == list(dst_lines):
            return ("keep", src_path)
        return ("modify", src_path)
    return ("rename", src_path, dst_path)


def hungarian(matrix):
    """Solve a square/rectangular assignment problem (min cost).

    ``matrix`` is a list of ``n`` rows of length ``m`` with ``n <= m``.
    Returns ``(u, v, match)`` with 1-based indexing: ``u``/``v`` are the
    dual potentials (``u[i] + v[j] <= matrix[i-1][j-1]`` with equality on
    matched edges) and ``match[i] = j`` means row ``i`` takes column ``j``.
    Works with arbitrary (including negative or huge) integer weights.
    """
    n = len(matrix)
    m = len(matrix[0])
    inf = float("inf")
    u = [0] * (n + 1)
    v = [0] * (m + 1)
    p = [0] * (m + 1)
    way = [0] * (m + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [inf] * (m + 1)
        used = [False] * (m + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = inf
            j1 = 0
            row = matrix[i0 - 1]
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = row[j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            p[j0] = p[way[j0]]
            j0 = way[j0]
    match = [0] * (n + 1)
    for j in range(1, m + 1):
        if p[j]:
            match[p[j]] = j
    return u, v, match


class MatchingContext:
    """Deterministic weight-matrix construction shared by solver/verifier.

    The square matrix has ``ns + nt`` rows and columns:

    * rows ``0..ns-1``: real source files
    * rows ``ns..``: dummy sources (an unmatched target is "added")
    * cols ``0..nt-1``: real target files
    * cols ``nt..``: dummy targets (an unmatched source is "deleted")

    Every edge weight is ``cost * W2 - secondary(op)`` where ``secondary``
    encodes the tie-break: maximizing the count of lexicographically
    small operations first, which is exactly equivalent to minimizing
    the sorted operation tuple lexicographically.
    """

    def __init__(self, source_files, target_files):
        self.source_files = {p: list(l) for p, l in source_files.items()}
        self.target_files = {p: list(l) for p, l in target_files.items()}
        self.s_paths = sorted(self.source_files)
        self.t_paths = sorted(self.target_files)
        self.ns = len(self.s_paths)
        self.nt = len(self.t_paths)
        self.size = self.ns + self.nt

        self._pair_cost = {}
        self._pair_op = {}
        op_universe = set()
        for s in self.s_paths:
            op_universe.add(("delete", s))
        for t in self.t_paths:
            op_universe.add(("add", t))
        for s in self.s_paths:
            for t in self.t_paths:
                cost = pair_cost(
                    s, self.source_files[s], t, self.target_files[t]
                )
                op = pair_operation(
                    s, self.source_files[s], t, self.target_files[t]
                )
                self._pair_cost[(s, t)] = cost
                self._pair_op[(s, t)] = op
                op_universe.add(op)
        self.op_rank = {op: i for i, op in enumerate(sorted(op_universe))}
        self.num_ranks = len(self.op_rank)
        # BASE exceeds the count of any operation in any matching, so the
        # secondary value below is a carry-free encoding of the count
        # vector of operation ranks.
        self.base = self.size + 1
        # W2 exceeds any possible absolute secondary total.
        self.w2 = (self.size + 1) * (self.base ** self.num_ranks)

    def secondary_of(self, op):
        return self.base ** (self.num_ranks - 1 - self.op_rank[op])

    def edge(self, i, j):
        """Return ``(cost, op)`` for matrix edge ``(i, j)`` (0-based)."""
        if i < self.ns and j < self.nt:
            s = self.s_paths[i]
            t = self.t_paths[j]
            return self._pair_cost[(s, t)], self._pair_op[(s, t)]
        if i < self.ns:
            s = self.s_paths[i]
            return delete_cost(self.source_files[s]), ("delete", s)
        if j < self.nt:
            t = self.t_paths[j]
            return add_cost(self.target_files[t]), ("add", t)
        return 0, None

    def weight(self, i, j):
        cost, op = self.edge(i, j)
        return cost * self.w2 - (self.secondary_of(op) if op else 0)

    def matrix(self):
        return [
            [self.weight(i, j) for j in range(self.size)]
            for i in range(self.size)
        ]

    def describe(self, matching):
        """Aggregate ``(cost, secondary, ops, assignments)`` of a matching.

        ``matching`` is a list of ``(row, col)`` pairs (0-based).
        """
        cost = 0
        secondary = 0
        ops = []
        assignments = []
        for i, j in sorted(matching):
            edge_cost, op = self.edge(i, j)
            cost += edge_cost
            if op is not None:
                secondary += self.secondary_of(op)
                ops.append(op)
            if i < self.ns and j < self.nt:
                assignments.append((self.s_paths[i], self.t_paths[j]))
            elif i < self.ns:
                assignments.append((self.s_paths[i], None))
            elif j < self.nt:
                assignments.append((None, self.t_paths[j]))
        return cost, secondary, tuple(sorted(ops)), assignments


class MatchingResult:
    def __init__(self, context, matching, cost, secondary, ops, assignments, u, v):
        self.context = context
        self.matching = matching
        self.cost = cost
        self.secondary = secondary
        self.combined = cost * context.w2 - secondary
        self.ops = ops
        self.assignments = assignments
        self.row_potentials = u
        self.col_potentials = v

    def certificate(self):
        return {
            "format": "filepatch-cert-1",
            "cost": self.cost,
            "secondary": self.secondary,
            "combined": self.combined,
            "matching": [[i, j] for i, j in self.matching],
            "row_potentials": list(self.row_potentials),
            "col_potentials": list(self.col_potentials),
        }


def solve(source_files, target_files):
    """Compute the minimum-cost matching plus its dual certificate."""
    ctx = MatchingContext(source_files, target_files)
    if ctx.size == 0:
        return MatchingResult(ctx, [], 0, 0, (), [], [], [])
    u, v, match = hungarian(ctx.matrix())
    matching = [(i - 1, match[i] - 1) for i in range(1, ctx.size + 1)]
    cost, secondary, ops, assignments = ctx.describe(matching)
    return MatchingResult(
        ctx, matching, cost, secondary, ops, assignments, u[1:], v[1:]
    )


def verify_certificate(source_files, target_files, certificate):
    """Verify optimality of a certified matching without any optimizer.

    Recomputes the weight matrix deterministically and checks the dual
    potentials: feasibility on every edge, tightness on matched edges,
    and equality of the primal and dual totals.  Raises
    ``CertificateError`` on any inconsistency; returns ``True`` otherwise.
    """
    try:
        if not isinstance(certificate, dict):
            raise CertificateError("certificate must be a JSON object")
        ctx = MatchingContext(source_files, target_files)
        if certificate.get("format") != "filepatch-cert-1":
            raise CertificateError("unknown certificate format")
        u = [int(x) for x in certificate["row_potentials"]]
        v = [int(x) for x in certificate["col_potentials"]]
        matching = [tuple(pair) for pair in certificate["matching"]]
        n = ctx.size
        if len(u) != n or len(v) != n or len(matching) != n:
            raise CertificateError("certificate dimensions do not match the trees")
        rows = [i for i, _ in matching]
        cols = [j for _, j in matching]
        if sorted(rows) != list(range(n)) or sorted(cols) != list(range(n)):
            raise CertificateError("matching is not a perfect assignment")
        for i in range(n):
            for j in range(n):
                if u[i] + v[j] > ctx.weight(i, j):
                    raise CertificateError(
                        "dual infeasible on edge (%d, %d)" % (i, j)
                    )
        primal = 0
        for i, j in matching:
            w = ctx.weight(i, j)
            if u[i] + v[j] != w:
                raise CertificateError(
                    "matched edge (%d, %d) is not tight" % (i, j)
                )
            primal += w
        if sum(u) + sum(v) != primal:
            raise CertificateError("primal and dual totals differ")
        cost, secondary, _ops, _assign = ctx.describe(matching)
        combined = cost * ctx.w2 - secondary
        if primal != combined:
            raise CertificateError("claimed objective does not match the matching")
        if certificate.get("cost") != cost:
            raise CertificateError("claimed cost does not match the matching")
        if certificate.get("secondary") != secondary:
            raise CertificateError("claimed tie-break value does not match")
        if certificate.get("combined") != combined:
            raise CertificateError("claimed combined objective does not match")
        return True
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, CertificateError):
            raise
        raise CertificateError("malformed certificate: %s" % exc) from exc
