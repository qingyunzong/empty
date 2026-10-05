"""symregex：基于 Brzozowski 导数的符号正则等价/包含判定库。"""
from .ast import Context, Node
from .parser import parse, ParseError
from .engine import (
    DiffResult, shortest_difference, equivalent, included, match,
    resume_difference, verify_proof, fingerprint, EQUIVALENT, DIFFERENT, UNKNOWN,
)
from .automaton import build_dfa, minimize
from .rules import RuleEngine

__all__ = [
    "Context", "Node", "parse", "ParseError",
    "DiffResult", "shortest_difference", "equivalent", "included", "match",
    "resume_difference", "verify_proof", "fingerprint",
    "EQUIVALENT", "DIFFERENT", "UNKNOWN",
    "build_dfa", "minimize", "RuleEngine",
]
