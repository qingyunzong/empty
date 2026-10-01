"""Cyclic sequence-number arithmetic with an explicit validity window.

Plain integer comparison is meaningless for wrap-around sequence numbers:
a sequence number is only ordered relative to the receive base while it
lies inside the advertised window.  Anything else must be classified as
OLD (behind the window) or FUTURE (beyond the window) -- never compared
with ``<`` / ``>``.
"""
from __future__ import annotations

import enum


class Region(enum.Enum):
    OLD = "old"          # behind the window: already seen / too old
    CURRENT = "current"  # inside the valid receive window
    FUTURE = "future"    # beyond the window: not yet acceptable


def check_window(window: int, modulus: int) -> None:
    if modulus <= 0 or modulus & (modulus - 1):
        raise ValueError("modulus must be a positive power of two")
    if not 0 < 2 * window <= modulus:
        raise ValueError("require 0 < 2*window <= modulus")


def forward_distance(start: int, end: int, modulus: int) -> int:
    """Number of forward steps from ``start`` to ``end`` on the cycle.

    Always in ``[0, modulus)``; this is the only safe "distance" between
    two cyclic sequence numbers.
    """
    return (end - start) % modulus


def classify(seq: int, base: int, window: int, modulus: int) -> Region:
    """Classify ``seq`` relative to the window ``[base, base+window)``.

    The classification is only meaningful because ``2*window <= modulus``:
    the cycle is partitioned into a current window, an equally sized old
    region directly behind the base, and an ambiguous future region that
    must be rejected rather than ordered.
    """
    check_window(window, modulus)
    dist = forward_distance(base, seq, modulus)
    if dist < window:
        return Region.CURRENT
    if dist >= modulus - window:
        return Region.OLD
    return Region.FUTURE
