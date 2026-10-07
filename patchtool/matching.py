"""Minimum-cost bipartite matching between source and destination files.

The pairing problem is reduced to a square assignment problem of size
``n + m`` (``n`` source files, ``m`` destination files):

* rows ``0..n-1``    : source files;  columns ``0..m-1``  : destination files
* rows ``n..n+m-1``  : "add" dummies; columns ``m..m+n-1``: "delete" dummies

Cell ``(i, j)`` (real/real) costs ``path_distance + content_distance``;
cell ``(i, m+i)`` costs the byte size of source ``i`` (delete); cell
``(n+j, j)`` costs the byte size of destination ``j`` (add); dummy/dummy
cells are zero; everything else is ``INF``.

The Hungarian solver also yields dual potentials ``u, v`` with
``u[i] + v[j] <= cost[i][j]`` and equality on matched edges, so
``sum(u) + sum(v)`` equals the optimum — an independently checkable
optimality certificate (see :mod:`patchtool.certificate`).

Among all optimal matchings, :func:`canonical_ops` selects the one whose
normalised operation sequence (sorted list of operation tuples) is
lexicographically smallest, via a greedy prefix-extension scheme backed by
constrained re-optimisation.
"""
from __future__ import annotations

from .distance import content_distance, path_distance
from .model import byte_count

INF = 10**12


def hungarian(cost):
    """Min-cost perfect matching on a square cost matrix.

    Returns ``(match, u, v, total)`` where ``match[i]`` is the column
    assigned to row ``i`` and ``u, v`` are dual potentials with
    ``u[i] + v[j] <= cost[i][j]`` (equality on matched edges) and
    ``sum(u) + sum(v) == total``.
    """
    n = len(cost)
    if n == 0:
        return [], [], [], 0
    u = [0.0] * (n + 1)
    v = [0.0] * (n + 1)
    p = [0] * (n + 1)   # p[j] = row matched to column j (1-indexed)
    way = [0] * (n + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [float("inf")] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = float("inf")
            j1 = 0
            for j in range(1, n + 1):
                if not used[j]:
                    cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
    match = [0] * n
    for j in range(1, n + 1):
        if p[j] > 0:
            match[p[j] - 1] = j - 1
    total = -v[0]
    return (match,
            [int(x) for x in u[1:]],
            [int(x) for x in v[1:]],
            int(total))


def pair_op(src_path, src_lines, dst_path, dst_lines):
    """The operation tuple emitted when source and destination are paired.

    Returns ``None`` for an identical (no-op) pairing.
    """
    if src_path == dst_path:
        if tuple(src_lines) == tuple(dst_lines):
            return None
        return ("modify", src_path)
    return ("rename", src_path, dst_path)


class CostModel:
    """Square assignment cost matrix between sorted source/dest file lists."""

    def __init__(self, src_files, dst_files):
        # src_files / dst_files: lists of (path, lines) sorted by path
        self.src = [(p, tuple(ls)) for p, ls in src_files]
        self.dst = [(p, tuple(ls)) for p, ls in dst_files]
        n, m = len(self.src), len(self.dst)
        self.n, self.m = n, m
        size = n + m
        self.size = size
        M = [[0] * size for _ in range(size)]
        for i in range(n):
            for j in range(size):
                M[i][j] = INF
            for j in range(m):
                M[i][j] = (path_distance(self.src[i][0], self.dst[j][0])
                           + content_distance(self.src[i][1], self.dst[j][1]))
            M[i][m + i] = byte_count(self.src[i][1])          # delete src i
        for j in range(m):
            for i in range(size):
                M[n + j][i] = INF
            M[n + j][j] = byte_count(self.dst[j][1])          # add dst j
            for i in range(n):
                M[n + j][m + i] = 0                           # dummy/dummy
        self.matrix = M

    def row_labels(self):
        return [["file", p] for p, _ in self.src] + [["add", p] for p, _ in self.dst]

    def col_labels(self):
        return [["file", p] for p, _ in self.dst] + [["del", p] for p, _ in self.src]


def _apply_constraints(model, present, absent):
    """Cost matrix with forced-present / forced-absent decisions applied."""
    n, m, size = model.n, model.m, model.size
    M = [row[:] for row in model.matrix]
    for con in present:
        if con[0] == "pair":
            _, i, j = con
            for jj in range(size):
                if jj != j:
                    M[i][jj] = INF
            for ii in range(size):
                if ii != i:
                    M[ii][j] = INF
        elif con[0] == "del":
            i = con[1]
            for j in range(m):
                M[i][j] = INF
        else:  # "add"
            j = con[1]
            for i in range(n):
                M[i][j] = INF
    for con in absent:
        if con[0] == "pair":
            M[con[1]][con[2]] = INF
        elif con[0] == "del":
            M[con[1]][m + con[1]] = INF
        else:  # "add"
            M[n + con[1]][con[1]] = INF
    return M


def constrained_cost(model, present, absent):
    """Optimum achievable under the given forced decisions (INF if infeasible)."""
    return hungarian(_apply_constraints(model, present, absent))[3]


def _try_exact(model, prefix, optimum):
    """If *prefix* is exactly realisable as a complete optimal operation
    sequence, return a concrete full assignment (row -> column); else None."""
    n, m, size = model.n, model.m, model.size
    src_index = {p: i for i, (p, _) in enumerate(model.src)}
    dst_index = {p: j for j, (p, _) in enumerate(model.dst)}
    used_src = {}
    used_dst = {}
    total = 0
    for op in prefix:
        kind = op[0]
        if kind == "add":
            j = dst_index.get(op[1])
            if j is None or j in used_dst:
                return None
            used_dst[j] = "add"
            total += byte_count(model.dst[j][1])
        elif kind == "delete":
            i = src_index.get(op[1])
            if i is None or i in used_src:
                return None
            used_src[i] = "del"
            total += byte_count(model.src[i][1])
        elif kind == "modify":
            i = src_index.get(op[1])
            j = dst_index.get(op[1])
            if i is None or j is None or i in used_src or j in used_dst:
                return None
            if model.src[i][1] == model.dst[j][1]:
                return None
            used_src[i] = ("pair", j)
            used_dst[j] = ("pair", i)
            total += content_distance(model.src[i][1], model.dst[j][1])
        elif kind == "rename":
            i = src_index.get(op[1])
            j = dst_index.get(op[2])
            if i is None or j is None or i in used_src or j in used_dst:
                return None
            if op[1] == op[2]:
                return None
            used_src[i] = ("pair", j)
            used_dst[j] = ("pair", i)
            total += (path_distance(op[1], op[2])
                      + content_distance(model.src[i][1], model.dst[j][1]))
        else:
            return None
    if total != optimum:
        return None
    # Every remaining source/destination must cancel out as a zero-cost
    # identical (no-op) pairing; any other completion would add operations.
    groups = {}
    for j in range(m):
        if j not in used_dst:
            groups.setdefault((model.dst[j][0], model.dst[j][1]), []).append(j)
    nopair = {}
    for i in range(n):
        if i in used_src:
            continue
        lst = groups.get((model.src[i][0], model.src[i][1]))
        if not lst:
            return None
        nopair[i] = lst.pop()
    if any(groups.values()):
        return None  # unpaired destination files would need 'add' operations
    # Materialise a concrete assignment on the (n+m) x (n+m) matrix.
    assignment = [None] * size
    for i, use in used_src.items():
        assignment[i] = m + i if use == "del" else use[1]
    for j, use in used_dst.items():
        if use == "add":
            assignment[n + j] = j
    for i, j in nopair.items():
        assignment[i] = j
    used_cols = {c for c in assignment if c is not None}
    free_rows = [r for r in range(size) if assignment[r] is None]
    free_cols = [c for c in range(size) if c not in used_cols]
    for r, c in zip(free_rows, free_cols):   # leftover dummies pair at cost 0
        assignment[r] = c
    return assignment


def canonical_ops(model, optimum):
    """Lexicographically smallest normalised operation sequence among all
    optimal matchings.  Returns ``(op_tuples, assignment)``.

    Greedy invariant: some optimal matching realises an operation sequence
    that starts with the committed prefix and avoids all absent operations.
    Each step either closes the sequence (exact realisation) or extends the
    prefix by the smallest operation that keeps an optimal completion.
    """
    n, m = model.n, model.m
    candidates = []
    for i, (sp, sl) in enumerate(model.src):
        for j, (dp, dl) in enumerate(model.dst):
            op = pair_op(sp, sl, dp, dl)
            if op is not None:
                candidates.append((op, ("pair", i, j)))
    for i, (sp, _sl) in enumerate(model.src):
        candidates.append((("delete", sp), ("del", i, None)))
    for j, (dp, _dl) in enumerate(model.dst):
        candidates.append((("add", dp), ("add", j, None)))
    candidates.sort(key=lambda item: item[0])

    prefix = []
    prefix_set = set()
    present = []
    absent = []
    absent_ops = set()
    while True:
        assignment = _try_exact(model, prefix, optimum)
        if assignment is not None:
            return list(prefix), assignment
        last = prefix[-1] if prefix else None
        committed = False
        for op, con in candidates:
            if op in prefix_set or op in absent_ops:
                continue
            if last is not None and op <= last:
                continue
            present.append(con)
            if constrained_cost(model, present, absent) == optimum:
                prefix.append(op)
                prefix_set.add(op)
                committed = True
                break
            present.pop()
            absent.append(con)
            absent_ops.add(op)
        if not committed:  # pragma: no cover - defensive
            raise AssertionError("canonicalisation failed: no extension found")
