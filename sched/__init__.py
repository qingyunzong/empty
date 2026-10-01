"""Conflict-serializable parallel schedule construction.

Given N transactions, each a sequence of read/write operations on named
keys, produce a round-based parallel schedule such that:

* two operations conflict iff they touch the same key and at least one is
  a write;
* operations in the same round are pairwise non-conflicting;
* the total number of rounds is minimal;
* ties between minimal-round schedules are broken deterministically by
  listing, round by round, operations in lexicographic (txn_id, op_index)
  order, placing every operation in the earliest round its predecessors
  allow;
* if the precedence graph has a cycle the input is not conflict
  serializable and an error describing one cycle is returned instead;
* the original operation order inside every transaction is preserved.
"""

from .core import (
    NON_SERIALIZABLE,
    Op,
    ScheduleError,
    conflicts,
    schedule_transactions,
)

__all__ = [
    "NON_SERIALIZABLE",
    "Op",
    "ScheduleError",
    "conflicts",
    "schedule_transactions",
]

__version__ = "1.0.0"
