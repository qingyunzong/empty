"""regex_deriv: regular expression equivalence and difference engine based
on Brzozowski derivatives, with symbolic (interval) automata, budgets with
resumable frontiers, equivalence proofs, and an independent Thompson
construction cross-checker.  Standard library only."""
import sys as _sys

if _sys.getrecursionlimit() < 10000:
    _sys.setrecursionlimit(10000)

from .alphabet import Alphabet, parse_alphabet
from .algebra import (
    binding_token, equivalent, included, match, shortest_difference,
    verify_proof,
)
from .automaton import BudgetExceeded, DFA, build_dfa, minimize
from .derivative import derive, partition
from .parser import parse
from .rules import RuleSet
from .syntax import (
    ALL, EMPTY, EPS, Node, char, compl, concat, from_json, from_raw,
    inter, nullable, star, to_json, to_str, union,
)

__version__ = "0.1.0"

__all__ = [
    "ALL", "Alphabet", "BudgetExceeded", "DFA", "EMPTY", "EPS", "Node",
    "RuleSet", "binding_token", "build_dfa", "char", "compl", "concat",
    "derive", "equivalent", "from_json", "from_raw", "included", "inter",
    "match", "minimize", "nullable", "parse", "parse_alphabet", "partition",
    "shortest_difference", "star", "to_json", "to_str", "union",
    "verify_proof",
]
