"""Deterministic three-way text merge."""

from .core import (
    OURS_MARKER,
    SEPARATOR_MARKER,
    THEIRS_MARKER,
    join_lines,
    lcs_align,
    main,
    merge,
    split_lines,
)

__all__ = [
    "OURS_MARKER",
    "SEPARATOR_MARKER",
    "THEIRS_MARKER",
    "join_lines",
    "lcs_align",
    "main",
    "merge",
    "split_lines",
]
