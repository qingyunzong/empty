"""Edit distances used by the cost model.

* Path distance: character-level Levenshtein distance (unit
  insert/delete/substitute).
* Content distance: length of the shortest line edit script (insertions +
  deletions only), i.e. ``len(a) + len(b) - 2 * lcs(a, b)``.

All distances are non-negative integers.
"""
from __future__ import annotations


def edit_distance(a, b):
    """Unit-cost Levenshtein distance between two sequences."""
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        ai = a[i - 1]
        for j in range(1, lb + 1):
            sub = 0 if ai == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub)
        prev = cur
    return prev[lb]


def script_length(a, b):
    """Shortest edit script length (insertions + deletions) between sequences."""
    la, lb = len(a), len(b)
    prev = [0] * (lb + 1)
    for i in range(1, la + 1):
        cur = [0] * (lb + 1)
        ai = a[i - 1]
        for j in range(1, lb + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
            else:
                cur[j] = prev[j] if prev[j] >= cur[j - 1] else cur[j - 1]
        prev = cur
    lcs = prev[lb]
    return la + lb - 2 * lcs


def path_distance(p, q):
    """Edit distance between two paths (character level)."""
    return edit_distance(p, q)


def content_distance(a, b):
    """Shortest line edit script length between two line sequences."""
    return script_length(a, b)
