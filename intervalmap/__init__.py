"""Persistent interval map with source-tagged coverage counts.

Half-open intervals over exact rational endpoints (Fraction), optional
infinite bounds, per-source coverage multisets, union / intersection /
difference, per-source revoke, coverage-threshold queries with source
proofs, nested transactions, historical snapshots and JSON persistence.
"""
from .core import IntervalMap
from .workspace import Workspace
from .checker import check_canonical, verify_threshold
from .endpoints import NEG_INF, POS_INF

__all__ = [
    "IntervalMap",
    "Workspace",
    "check_canonical",
    "verify_threshold",
    "NEG_INF",
    "POS_INF",
]
