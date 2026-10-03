"""Core Bareiss fraction-free elimination with complete pivoting.

The elimination works on an integer working matrix ``M`` (the input matrix
augmented with any right-hand-side columns).  Every elimination update keeps
all entries integral by dividing by the previous pivot; that division is
*checked* with :func:`exact_div` and never silently truncated.

A rational transform matrix ``T`` is maintained alongside so that
``M == T @ original_augmented_matrix`` at every step.  Rows of ``T`` below the
rank provide inconsistency certificates.
"""

from __future__ import annotations

from fractions import Fraction
from typing import NamedTuple


class DivisibilityError(ArithmeticError):
    """An exact division required by Bareiss elimination failed."""


def exact_div(numerator, denominator, context=""):
    """Integer division that refuses to truncate silently."""
    if denominator == 0:
        raise DivisibilityError(f"zero denominator at {context or 'division'}")
    quotient, remainder = divmod(numerator, denominator)
    if remainder:
        raise DivisibilityError(
            f"{numerator} is not divisible by {denominator}"
            + (f" (at {context})" if context else "")
        )
    return quotient


class State:
    """Mutable working state of one elimination run."""

    __slots__ = (
        "M",
        "T",
        "prev",
        "row_perm",
        "col_perm",
        "step",
        "rank",
        "done",
        "row_swaps",
        "col_swaps",
    )

    def __init__(self, M, T, prev, row_perm, col_perm, step, rank, done,
                 row_swaps, col_swaps):
        self.M = M
        self.T = T
        self.prev = prev
        self.row_perm = row_perm
        self.col_perm = col_perm
        self.step = step
        self.rank = rank
        self.done = done
        self.row_swaps = row_swaps
        self.col_swaps = col_swaps


class Snapshot(NamedTuple):
    """Immutable checkpoint of a :class:`State` (safe to share)."""

    M: tuple
    T: tuple
    prev: int
    row_perm: tuple
    col_perm: tuple
    step: int
    rank: object
    done: bool
    row_swaps: int
    col_swaps: int


def take_snapshot(state):
    return Snapshot(
        M=tuple(tuple(row) for row in state.M),
        T=tuple(tuple(row) for row in state.T),
        prev=state.prev,
        row_perm=tuple(state.row_perm),
        col_perm=tuple(state.col_perm),
        step=state.step,
        rank=state.rank,
        done=state.done,
        row_swaps=state.row_swaps,
        col_swaps=state.col_swaps,
    )


def restore_snapshot(snap):
    return State(
        M=[list(row) for row in snap.M],
        T=[list(row) for row in snap.T],
        prev=snap.prev,
        row_perm=list(snap.row_perm),
        col_perm=list(snap.col_perm),
        step=snap.step,
        rank=snap.rank,
        done=snap.done,
        row_swaps=snap.row_swaps,
        col_swaps=snap.col_swaps,
    )


def eliminate_one_step(state, n_cols, log):
    """Run one pivot step.  Returns True if a pivot was processed.

    ``n_cols`` is the number of coefficient columns; augmented columns are
    eliminated along but never used as pivots.  Complete pivoting searches the
    whole remaining block, so a zero pivot position never aborts the
    elimination while a nonzero entry remains in the block.
    """
    m = len(state.M)
    total_cols = len(state.M[0]) if m else 0
    k = state.step
    if k >= m or k >= n_cols:
        state.rank = k
        state.done = True
        return False

    best_pos = None
    best_abs = 0
    for i in range(k, m):
        row = state.M[i]
        for j in range(k, n_cols):
            value = row[j]
            if value and abs(value) > best_abs:
                best_abs = abs(value)
                best_pos = (i, j)
    if best_pos is None:
        # The entire remaining block is genuinely zero.
        state.rank = k
        state.done = True
        log.append({"step": k, "op": "zero_block", "row_start": k, "col_start": k})
        return False

    pi, pj = best_pos
    if pi != k:
        state.M[k], state.M[pi] = state.M[pi], state.M[k]
        state.T[k], state.T[pi] = state.T[pi], state.T[k]
        state.row_perm[k], state.row_perm[pi] = state.row_perm[pi], state.row_perm[k]
        state.row_swaps += 1
        log.append({"step": k, "op": "swap_rows", "i": k, "j": pi})
    if pj != k:
        for row in state.M:
            row[k], row[pj] = row[pj], row[k]
        state.col_perm[k], state.col_perm[pj] = state.col_perm[pj], state.col_perm[k]
        state.col_swaps += 1
        log.append({"step": k, "op": "swap_cols", "i": k, "j": pj})

    pivot = state.M[k][k]
    prev = state.prev
    pivot_row = state.M[k]
    pivot_trow = state.T[k]
    for i in range(k + 1, m):
        row = state.M[i]
        trow = state.T[i]
        factor = row[k]
        if factor == 0:
            # The row is still rescaled by pivot / prev; skipping this would
            # break the divisibility invariant of later steps.
            if pivot != prev:
                for j in range(k + 1, total_cols):
                    row[j] = exact_div(
                        row[j] * pivot, prev, f"step {k} row {i} col {j}"
                    )
                for c in range(m):
                    trow[c] = Fraction(trow[c] * pivot, prev)
            row[k] = 0
            continue
        for j in range(k + 1, total_cols):
            row[j] = exact_div(
                row[j] * pivot - factor * pivot_row[j],
                prev,
                f"step {k} row {i} col {j}",
            )
        row[k] = 0
        for c in range(m):
            trow[c] = Fraction(trow[c] * pivot - factor * pivot_trow[c], prev)

    state.prev = pivot
    state.step = k + 1
    log.append(
        {
            "step": k,
            "op": "eliminate",
            "pivot": pivot,
            "prev": prev,
            "pivot_row": state.row_perm[k],
            "pivot_col": state.col_perm[k],
        }
    )
    return True
