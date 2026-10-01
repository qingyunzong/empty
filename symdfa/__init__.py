"""Symbolic DFA minimization with certificates and incremental updates."""

from .dfa import (
    DFAError,
    GapError,
    InverseIndex,
    OverlapError,
    SymbolicDFA,
    merge_intervals,
    reachable,
)
from .incremental import IncrementalMinimizer, ValidationError
from .minimize import MinimizationResult, Partition, minimize, validate_partition
from .proof import ProofDAG, build_proof_dag
from .serialize import dfa_from_json, dfa_to_json
from .verify import VerificationError, verify_certificate

__all__ = [
    "DFAError",
    "GapError",
    "IncrementalMinimizer",
    "InverseIndex",
    "MinimizationResult",
    "OverlapError",
    "Partition",
    "ProofDAG",
    "SymbolicDFA",
    "ValidationError",
    "VerificationError",
    "build_proof_dag",
    "dfa_from_json",
    "dfa_to_json",
    "merge_intervals",
    "minimize",
    "reachable",
    "validate_partition",
    "verify_certificate",
]
