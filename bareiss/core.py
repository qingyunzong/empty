"""Exact Bareiss fraction-free elimination with complete pivoting.

Everything is exact integer arithmetic.  The Bareiss update

    a[i][j] <- (a[i][j] * pivot - a[i][k] * a[k][j]) / prev_pivot

is guaranteed to divide exactly for integer matrices (Sylvester's
determinantal identity) for *any* sequence of nonzero pivots.  We still
CHECK every division and raise :class:`BareissIntegralityError` instead of
silently truncating, so a corrupted checkpoint or a bug is caught loudly.
"""
from __future__ import annotations

import json
import math
from fractions import Fraction


class BareissIntegralityError(ArithmeticError):
    """An exact division required by Bareiss elimination failed."""


def _check_matrix(matrix):
    rows = [list(row) for row in matrix]
    if not rows:
        return rows, 0, 0
    width = len(rows[0])
    for row in rows:
        if len(row) != width:
            raise ValueError("ragged matrix")
        for value in row:
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError("matrix entries must be integers")
    return rows, len(rows), width


def _scale_to_int(frac_vector):
    """Scale a vector of Fractions to a primitive integer vector."""
    den = 1
    for value in frac_vector:
        den = den * value.denominator // math.gcd(den, value.denominator)
    ints = [int(value * den) for value in frac_vector]
    g = 0
    for value in ints:
        g = math.gcd(g, abs(value))
    if g > 1:
        ints = [value // g for value in ints]
    return ints


class Factorization:
    """Immutable Bareiss factorization of an integer matrix.

    Attributes after :meth:`compute`:
      matrix, rows, cols   -- the (copied) input
      final                -- the eliminated matrix (integer, upper
                              trapezoidal in the permuted ordering)
      row_perm, col_perm   -- row_perm[i] is the original row now at
                              position i (same for columns)
      steps                -- elimination log, one dict per pivot step
      rank                 -- number of pivots
      row_swaps, col_swaps -- swap counts (determinant sign)
      notes                -- human-readable reuse / fallback notes
    """

    def __init__(self, matrix):
        self.matrix, self.rows, self.cols = _check_matrix(matrix)
        self.row_perm = list(range(self.rows))
        self.col_perm = list(range(self.cols))
        self.steps = []
        self.rank = 0
        self.final = [row[:] for row in self.matrix]
        self.row_swaps = 0
        self.col_swaps = 0
        self.notes = []

    # ------------------------------------------------------------------
    # factorization
    # ------------------------------------------------------------------
    @classmethod
    def compute(cls, matrix, reuse_from=None, changed_rows=None):
        """Factor ``matrix``; optionally reuse a prefix of ``reuse_from``.

        Recorded steps of the older factorization are replayed while they
        remain valid (recorded pivot entry still nonzero, cached pivot value
        still consistent for untouched rows, and every exact division still
        exact).  On the first divergence or integrality failure the state is
        rolled back to just before that step and the remaining steps are
        recomputed with fresh complete pivoting.
        """
        self = cls(matrix)
        self._changed_rows = changed_rows
        A = self.final
        prev_pivot = 1
        old_steps = reuse_from.steps if reuse_from is not None else []
        limit = min(self.rows, self.cols)
        k = 0
        while k < limit:
            step = None
            if k < len(old_steps):
                step = self._try_reuse(old_steps[k], k, prev_pivot, A)
            if step is None:
                step = self._fresh_step(k, prev_pivot, A)
                if step is None:
                    self.notes.append(
                        f"step {k}: remaining {self.rows - k}x{self.cols - k} "
                        f"block is exactly zero; rank = {k}")
                    break
            self.steps.append(step)
            prev_pivot = step["pivot_value"]
            k += 1
        self.rank = k
        return self

    def _snapshot(self):
        return ([row[:] for row in self.final], self.row_perm[:],
                self.col_perm[:], self.row_swaps, self.col_swaps)

    def _restore(self, snap):
        rows, row_perm, col_perm, row_swaps, col_swaps = snap
        for i in range(len(rows)):
            self.final[i][:] = rows[i]
        self.row_perm[:] = row_perm
        self.col_perm[:] = col_perm
        self.row_swaps = row_swaps
        self.col_swaps = col_swaps

    def _apply_swaps(self, row_swap, col_swap):
        A = self.final
        if row_swap:
            i, j = row_swap
            A[i], A[j] = A[j], A[i]
            self.row_perm[i], self.row_perm[j] = self.row_perm[j], self.row_perm[i]
            self.row_swaps += 1
        if col_swap:
            i, j = col_swap
            for row in A:
                row[i], row[j] = row[j], row[i]
            self.col_perm[i], self.col_perm[j] = self.col_perm[j], self.col_perm[i]
            self.col_swaps += 1

    def _eliminate(self, k, pivot, prev_pivot):
        A = self.final
        column = [A[i][k] for i in range(k + 1, self.rows)]
        for i in range(k + 1, self.rows):
            aik = A[i][k]
            row_i = A[i]
            row_k = A[k]
            for j in range(k + 1, self.cols):
                num = row_i[j] * pivot - aik * row_k[j]
                q, r = divmod(num, prev_pivot)
                if r:
                    raise BareissIntegralityError(
                        f"step {k}: numerator {num} not divisible by previous "
                        f"pivot {prev_pivot} at entry ({i},{j})")
                row_i[j] = q
        for i in range(k + 1, self.rows):
            A[i][k] = 0
        return column

    def _try_reuse(self, old, k, prev_pivot, A):
        snap = self._snapshot()
        try:
            self._apply_swaps(old["row_swap"], old["col_swap"])
            pivot = A[k][k]
            if pivot == 0:
                self.notes.append(
                    f"step {k}: recorded pivot entry became zero after the "
                    f"update; recomputing from this step")
                self._restore(snap)
                return None
            if (self._changed_rows is not None
                    and self.row_perm[k] not in self._changed_rows
                    and pivot != old["pivot_value"]):
                self.notes.append(
                    f"step {k}: cached pivot value {old['pivot_value']} is "
                    f"stale for untouched row {self.row_perm[k]} (now "
                    f"{pivot}); cache rejected, recomputing from this step")
                self._restore(snap)
                return None
            column = self._eliminate(k, pivot, prev_pivot)
        except BareissIntegralityError as exc:
            self.notes.append(
                f"step {k}: integrality check failed while replaying a cached "
                f"step ({exc}); rolled back and recomputing from this step")
            self._restore(snap)
            return None
        step = {"step": k, "pivot_row": k, "pivot_col": k,
                "pivot_value": pivot, "prev_pivot": prev_pivot,
                "column": column,
                "row_swap": list(old["row_swap"]) if old["row_swap"] else None,
                "col_swap": list(old["col_swap"]) if old["col_swap"] else None,
                "reused": True}
        if pivot != old["pivot_value"]:
            step["pivot_value_changed"] = True
            self.notes.append(
                f"step {k}: reused elimination with a changed pivot value "
                f"({old['pivot_value']} -> {pivot}); still exact")
        return step

    def _fresh_step(self, k, prev_pivot, A):
        # complete pivoting: largest |entry| in the remaining block
        best = 0
        bi = bj = -1
        for i in range(k, self.rows):
            for j in range(k, self.cols):
                value = abs(A[i][j])
                if value > best:
                    best = value
                    bi, bj = i, j
        if bi < 0:
            return None  # remaining block is exactly zero
        row_swap = [k, bi] if bi != k else None
        col_swap = [k, bj] if bj != k else None
        self._apply_swaps(row_swap, col_swap)
        pivot = A[k][k]
        column = self._eliminate(k, pivot, prev_pivot)
        return {"step": k, "pivot_row": k, "pivot_col": k,
                "pivot_value": pivot, "prev_pivot": prev_pivot,
                "column": column, "row_swap": row_swap,
                "col_swap": col_swap, "reused": False}

    # ------------------------------------------------------------------
    # derived quantities
    # ------------------------------------------------------------------
    def determinant(self):
        if self.rows != self.cols:
            raise ValueError("determinant requires a square matrix")
        if self.rank < self.rows:
            return 0
        if not self.steps:
            return 1  # 0x0 matrix
        sign = -1 if (self.row_swaps + self.col_swaps) % 2 else 1
        return sign * self.steps[-1]["pivot_value"]

    def forward(self, B):
        """Replay the recorded elimination on an integer m x p matrix B."""
        B = [list(row) for row in B]
        if len(B) != self.rows:
            raise ValueError("row count mismatch")
        width = len(B[0]) if B else 0
        for row in B:
            if len(row) != width:
                raise ValueError("ragged right-hand side")
            for value in row:
                if isinstance(value, bool) or not isinstance(value, int):
                    raise TypeError("right-hand side entries must be integers")
        prev_pivot = 1
        for step in self.steps:
            if step["row_swap"]:
                i, j = step["row_swap"]
                B[i], B[j] = B[j], B[i]
            k = step["step"]
            pivot = step["pivot_value"]
            column = step["column"]
            for idx, i in enumerate(range(k + 1, self.rows)):
                aik = column[idx]
                for c in range(width):
                    num = B[i][c] * pivot - aik * B[k][c]
                    q, r = divmod(num, prev_pivot)
                    if r:
                        raise BareissIntegralityError(
                            f"forward step {k}: numerator {num} not divisible "
                            f"by previous pivot {prev_pivot}")
                    B[i][c] = q
            prev_pivot = pivot
        return B

    def certificate(self, row_index):
        """Integer y with y^T A = 0 and y^T b = (eliminated b)[row_index].

        The forward pass defines an integer matrix M with B' = M B (every
        intermediate state of forward(integer input) is integral).  The
        certificate is row ``row_index`` of M, obtained by replaying the
        recorded elimination on the identity matrix.
        """
        identity = [[1 if c == r else 0 for c in range(self.rows)]
                    for r in range(self.rows)]
        transform = self.forward(identity)
        return transform[row_index]

    def null_space(self):
        """Integer basis of {x : A x = 0} in the original column order."""
        n = self.cols
        U = self.final
        basis = []
        for free in range(self.rank, n):
            x = [Fraction(0)] * n
            x[free] = Fraction(1)
            for i in reversed(range(self.rank)):
                s = Fraction(0)
                for j in range(i + 1, n):
                    if U[i][j]:
                        s -= U[i][j] * x[j]
                x[i] = s / U[i][i]
            v = [Fraction(0)] * n
            for j in range(n):
                v[self.col_perm[j]] = x[j]
            basis.append(_scale_to_int(v))
        return basis

    def solve(self, rhs):
        """Solve A x = b for each vector b in ``rhs`` (list of int lists)."""
        vectors = [list(v) for v in rhs]
        for v in vectors:
            if len(v) != self.rows:
                raise ValueError("right-hand side length mismatch")
            for value in v:
                if isinstance(value, bool) or not isinstance(value, int):
                    raise TypeError("right-hand side entries must be integers")
        if not vectors:
            return []
        p = len(vectors)
        B = [[vectors[c][i] for c in range(p)] for i in range(self.rows)]
        Bp = self.forward(B)
        return [self._extract([Bp[i][c] for i in range(self.rows)])
                for c in range(p)]

    def _extract(self, bcol):
        n = self.cols
        r = self.rank
        U = self.final
        bad = next((i for i in range(r, self.rows) if bcol[i] != 0), None)
        if bad is not None:
            return {"status": "inconsistent",
                    "particular": None,
                    "null_basis": [],
                    "certificate": self.certificate(bad)}
        x = [Fraction(0)] * n
        for i in reversed(range(r)):
            s = Fraction(bcol[i])
            for j in range(i + 1, n):
                if U[i][j]:
                    s -= U[i][j] * x[j]
            x[i] = s / U[i][i]
        particular = [Fraction(0)] * n
        for j in range(n):
            particular[self.col_perm[j]] = x[j]
        status = "unique" if r == n else "infinite"
        return {"status": status,
                "particular": particular,
                "null_basis": self.null_space(),
                "certificate": None}

    # ------------------------------------------------------------------
    # serialization (checkpoints)
    # ------------------------------------------------------------------
    def to_dict(self):
        return {"matrix": self.matrix,
                "row_perm": self.row_perm,
                "col_perm": self.col_perm,
                "steps": self.steps,
                "rank": self.rank,
                "final": self.final,
                "row_swaps": self.row_swaps,
                "col_swaps": self.col_swaps,
                "notes": self.notes}

    @classmethod
    def from_dict(cls, data):
        self = cls(data["matrix"])
        self.row_perm = list(data["row_perm"])
        self.col_perm = list(data["col_perm"])
        self.steps = [dict(step) for step in data["steps"]]
        self.rank = data["rank"]
        self.final = [list(row) for row in data["final"]]
        self.row_swaps = data["row_swaps"]
        self.col_swaps = data["col_swaps"]
        self.notes = list(data.get("notes", []))
        return self


class LinearSystem:
    """A queryable, immutable snapshot of an integer linear system."""

    def __init__(self, matrix, _fact=None):
        self.factorization = _fact if _fact is not None else Factorization.compute(matrix)

    @property
    def matrix(self):
        return self.factorization.matrix

    @property
    def rank(self):
        return self.factorization.rank

    def determinant(self):
        return self.factorization.determinant()

    def null_space(self):
        return self.factorization.null_space()

    def solve(self, rhs):
        return self.factorization.solve(rhs)

    def updated(self, replace_rows=None, add_rows=None):
        """Return a NEW system with rows replaced/appended.

        The still-valid prefix of the current factorization is reused;
        steps that no longer divide exactly (or whose pivot vanished) are
        recomputed.  ``self`` is never mutated, so old snapshots stay
        queryable; a validation error leaves everything untouched.
        """
        fact = self.factorization
        matrix = [row[:] for row in fact.matrix]
        for index, row in (replace_rows or {}).items():
            index = int(index)
            if not 0 <= index < fact.rows:
                raise ValueError(f"row index {index} out of range")
            row = list(row)
            if len(row) != fact.cols:
                raise ValueError("replacement row has wrong length")
            matrix[index] = row
        for row in (add_rows or []):
            row = list(row)
            if len(row) != fact.cols:
                raise ValueError("added row has wrong length")
            matrix.append(row)
        changed = {int(i) for i in (replace_rows or {})}
        changed.update(range(fact.rows, len(matrix)))
        new_fact = Factorization.compute(matrix, reuse_from=fact,
                                         changed_rows=changed)
        return LinearSystem(matrix, _fact=new_fact)

    def save_checkpoint(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.factorization.to_dict(), fh)

    @classmethod
    def load_checkpoint(cls, path):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return cls(data["matrix"], _fact=Factorization.from_dict(data))
