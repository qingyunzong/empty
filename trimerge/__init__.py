"""Deterministic three-way text merge (LCS based)."""

from __future__ import annotations

__all__ = ["lcs_alignment", "merge_lines", "merge_text", "split_lines", "join_lines"]

CONFLICT_OURS = "<<<<<<< ours"
CONFLICT_SEP = "======="
CONFLICT_THEIRS = ">>>>>>> theirs"


def split_lines(text):
    """Split text into a line sequence on LF; empty text is an empty sequence."""
    if text == "":
        return []
    return text.split("\n")


def join_lines(lines):
    """Join a line sequence with LF."""
    return "\n".join(lines)


def lcs_alignment(base, side):
    """Return the deterministic LCS alignment between base and side.

    The result is a list of (base_index, side_index) matched pairs.  Among
    all longest common subsequence matchings, the lexicographically smallest
    sequence of matched index pairs is returned.
    """
    n = len(base)
    m = len(side)
    # dp[i][j] = LCS length of base[i:] and side[j:]
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row = dp[i]
        below = dp[i + 1]
        base_i = base[i]
        for j in range(m - 1, -1, -1):
            if base_i == side[j]:
                row[j] = below[j + 1] + 1
            else:
                best = below[j]
                if row[j + 1] > best:
                    best = row[j + 1]
                row[j] = best
    pairs = []
    i = 0
    j = 0
    while i < n and j < m and dp[i][j] > 0:
        need = dp[i][j]
        chosen = None
        for i2 in range(i, n):
            if dp[i2][j] < need:
                break
            row = dp[i2]
            base_i2 = base[i2]
            for j2 in range(j, m):
                if row[j2] < need:
                    break
                if base_i2 == side[j2] and row[j2] == need:
                    chosen = (i2, j2)
                    break
            if chosen is not None:
                break
        pairs.append(chosen)
        i = chosen[0] + 1
        j = chosen[1] + 1
    return pairs


def merge_lines(base, ours, theirs):
    """Three-way merge of line sequences.

    Returns (merged_lines, conflict_count).  Conflict regions are emitted
    with standard <<<<<<< ours / ======= / >>>>>>> theirs markers.
    """
    matches_ours = dict(lcs_alignment(base, ours))
    matches_theirs = dict(lcs_alignment(base, theirs))
    anchors = sorted(set(matches_ours) & set(matches_theirs))

    out = []
    conflicts = 0
    b_lo = 0
    o_lo = 0
    t_lo = 0

    def emit_region(b_hi, o_hi, t_hi):
        nonlocal conflicts
        b_seg = base[b_lo:b_hi]
        o_seg = ours[o_lo:o_hi]
        t_seg = theirs[t_lo:t_hi]
        if o_seg == b_seg:
            out.extend(t_seg)
        elif t_seg == b_seg or o_seg == t_seg:
            out.extend(o_seg)
        else:
            conflicts += 1
            out.append(CONFLICT_OURS)
            out.extend(o_seg)
            out.append(CONFLICT_SEP)
            out.extend(t_seg)
            out.append(CONFLICT_THEIRS)

    for b in anchors:
        emit_region(b, matches_ours[b], matches_theirs[b])
        out.append(base[b])
        b_lo = b + 1
        o_lo = matches_ours[b] + 1
        t_lo = matches_theirs[b] + 1
    emit_region(len(base), len(ours), len(theirs))
    return out, conflicts


def merge_text(base_text, ours_text, theirs_text):
    """Merge three texts; returns (merged_text, conflict_count)."""
    merged, conflicts = merge_lines(
        split_lines(base_text), split_lines(ours_text), split_lines(theirs_text)
    )
    return join_lines(merged), conflicts
