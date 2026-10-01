"""Deterministic three-way text merge.

Semantics
---------
* Files are decoded as UTF-8 and split into lines on LF.  The empty file
  yields the empty line sequence; output is the lines joined with LF.
* Both sides are aligned to base with a deterministic LCS: among all
  longest common subsequence matchings, the one whose sequence of matched
  line-number pairs ``(base_index, other_index)`` is lexicographically
  smallest is chosen.
* Base lines matched in *both* alignments are synchronisation points.
  Between two consecutive synchronisation points each side contributes a
  segment; the segments are resolved as follows:

  - a side whose segment equals the base segment did not change anything;
    the other side's segment is adopted;
  - if both sides produced the same segment, it is adopted;
  - otherwise (both sides changed the same base region differently,
    including modify-vs-delete and differing insertions into the same gap)
    the region is a conflict.

* Conflicts are emitted as::

      <<<<<<< ours
      <ours segment>
      =======
      <theirs segment>
      >>>>>>> theirs
"""

from __future__ import annotations

import argparse
import sys

OURS_MARKER = "<<<<<<< ours"
SEPARATOR_MARKER = "======="
THEIRS_MARKER = ">>>>>>> theirs"


def split_lines(text):
    """Split *text* into a line sequence on LF.

    The empty string yields the empty sequence.  A trailing LF acts as a
    line terminator, so ``"a\\n"`` splits to ``["a", ""]`` and joining the
    sequence with LF reproduces the original text.
    """
    if text == "":
        return []
    return text.split("\n")


def join_lines(lines):
    """Join a line sequence with LF (no trailing newline is added)."""
    return "\n".join(lines)


def lcs_align(base, other):
    """Return the deterministic LCS alignment between *base* and *other*.

    The result is a list of ``(base_index, other_index)`` pairs, strictly
    increasing in both components, whose matched lines are equal.  Among
    all longest common subsequence matchings the lexicographically
    smallest sequence of pairs is returned.
    """
    n, m = len(base), len(other)
    # lcs[i][j] = LCS length of base[i:] and other[j:].
    lcs = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, below = lcs[i], lcs[i + 1]
        base_line = base[i]
        for j in range(m - 1, -1, -1):
            if base_line == other[j]:
                row[j] = below[j + 1] + 1
            elif below[j] >= row[j + 1]:
                row[j] = below[j]
            else:
                row[j] = row[j + 1]

    matches = []
    i = j = 0
    remaining = lcs[0][0]
    while remaining > 0:
        # A pair (i, j) can be the next match of an LCS alignment iff
        # base[i] == other[j] and lcs[i][j] == remaining.  Picking the
        # lexicographically smallest feasible pair at every step yields
        # the lexicographically smallest match sequence overall.
        for ii in range(i, n):
            if lcs[ii][j] < remaining:
                break  # lcs[ii][j] is non-increasing in j; no match left.
            base_line = base[ii]
            for jj in range(j, m):
                if base_line == other[jj] and lcs[ii][jj] == remaining:
                    matches.append((ii, jj))
                    i, j = ii + 1, jj + 1
                    remaining -= 1
                    break
            else:
                continue
            break
    return matches


def merge(base, ours, theirs):
    """Three-way merge of line sequences.

    Returns ``(merged_lines, conflict_count)``.
    """
    matches_ours = lcs_align(base, ours)
    matches_theirs = lcs_align(base, theirs)
    ours_for = dict(matches_ours)
    theirs_for = dict(matches_theirs)

    # Base lines matched in both alignments anchor both sides; a sentinel
    # at the end flushes the final region.
    sync_points = sorted(b for b in ours_for if b in theirs_for)
    sync_points.append(len(base))

    merged = []
    conflicts = 0
    prev_b = prev_o = prev_t = -1
    for b in sync_points:
        o = ours_for.get(b, len(ours))
        t = theirs_for.get(b, len(theirs))
        base_seg = base[prev_b + 1 : b]
        ours_seg = ours[prev_o + 1 : o]
        theirs_seg = theirs[prev_t + 1 : t]

        if ours_seg == base_seg and theirs_seg == base_seg:
            merged.extend(base_seg)
        elif ours_seg == base_seg:
            merged.extend(theirs_seg)
        elif theirs_seg == base_seg:
            merged.extend(ours_seg)
        elif ours_seg == theirs_seg:
            merged.extend(ours_seg)
        else:
            merged.append(OURS_MARKER)
            merged.extend(ours_seg)
            merged.append(SEPARATOR_MARKER)
            merged.extend(theirs_seg)
            merged.append(THEIRS_MARKER)
            conflicts += 1

        if b < len(base):
            merged.append(base[b])
        prev_b, prev_o, prev_t = b, o, t
    return merged, conflicts


def _read_lines(path):
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return split_lines(handle.read())


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="trimerge",
        description="Deterministic three-way text merge.",
    )
    parser.add_argument("base", help="common ancestor file")
    parser.add_argument("ours", help="our side of the merge")
    parser.add_argument("theirs", help="their side of the merge")
    parser.add_argument(
        "-o",
        "--output",
        required=True,
        help="destination file for the merge result",
    )
    args = parser.parse_args(argv)

    try:
        base = _read_lines(args.base)
        ours = _read_lines(args.ours)
        theirs = _read_lines(args.theirs)
    except (OSError, UnicodeDecodeError) as exc:
        print(f"trimerge: error: {exc}", file=sys.stderr)
        return 2

    merged, conflicts = merge(base, ours, theirs)
    try:
        with open(args.output, "w", encoding="utf-8", newline="") as handle:
            handle.write(join_lines(merged))
    except OSError as exc:
        print(f"trimerge: error: {exc}", file=sys.stderr)
        return 2

    if conflicts:
        print(f"trimerge: {conflicts} conflict(s)", file=sys.stderr)
        return 1
    return 0
