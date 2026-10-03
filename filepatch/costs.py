"""Cost functions.  All costs are non-negative integers."""
from __future__ import annotations


def levenshtein(a, b):
    """Unit-cost edit distance between two strings (used for paths)."""
    if a == b:
        return 0
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (0 if ca == cb else 1),
                )
            )
        previous = current
    return previous[-1]


def _lcs_length(a, b):
    if len(a) > len(b):
        a, b = b, a
    previous = [0] * (len(a) + 1)
    for cb in b:
        current = [0]
        for i, ca in enumerate(a, 1):
            current.append(
                previous[i - 1] + 1 if ca == cb else max(previous[i], current[i - 1])
            )
        previous = current
    return previous[-1]


def line_edit_script_length(a, b):
    """Length of the shortest line edit script (insertions + deletions)."""
    return len(a) + len(b) - 2 * _lcs_length(list(a), list(b))


def content_bytes(lines):
    """Byte size of a file's content (each line plus its newline)."""
    return sum(len(line.encode("utf-8")) + 1 for line in lines)


def pair_cost(src_path, src_lines, dst_path, dst_lines):
    """Cost of pairing a source file with a target file.

    Equal to the path edit distance plus the content edit distance
    (shortest line edit script length).  For identical paths this is
    exactly the modify cost; for identical path and content it is 0.
    """
    return levenshtein(src_path, dst_path) + line_edit_script_length(
        src_lines, dst_lines
    )


def add_cost(lines):
    """Cost of adding a file: its byte count."""
    return content_bytes(lines)


def delete_cost(lines):
    """Cost of deleting a file: its byte count."""
    return content_bytes(lines)
