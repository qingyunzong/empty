"""Symbolic DFA equivalence and inclusion checking library."""

from .explore import EQUIVALENCE, INCLUSION, Result, check, partition_transitions
from .incremental import build_reuse, changed_states_since, invalidate_proof
from .machine import MAX_CHAR, Machine, MachineError
from .proof import verify_counterexample, verify_proof

__all__ = [
    "EQUIVALENCE",
    "INCLUSION",
    "MAX_CHAR",
    "Machine",
    "MachineError",
    "Result",
    "build_reuse",
    "changed_states_since",
    "check",
    "invalidate_proof",
    "partition_transitions",
    "verify_counterexample",
    "verify_proof",
]
