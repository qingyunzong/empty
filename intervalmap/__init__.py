"""Persistent interval map with per-source coverage counts.

Half-open intervals [lo, hi) with exact rational endpoints (Fraction) and
signed-infinity sentinels, stored in a persistent balanced interval tree
(treap with split/merge).  Supports union / intersection / difference,
per-source undo, coverage-threshold queries with source proofs, O(1)
snapshots and nested transactions.
"""

from .core import IntervalMap, Version
from .endpoints import NEG_INF, POS_INF, parse_endpoint, format_endpoint
from .model import SweepModel
from . import checker

__all__ = [
    "IntervalMap",
    "Version",
    "SweepModel",
    "NEG_INF",
    "POS_INF",
    "parse_endpoint",
    "format_endpoint",
    "checker",
]
