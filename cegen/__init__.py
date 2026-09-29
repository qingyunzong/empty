"""cegen: minimal counterexample generation and bounded proofs."""
from .engine import (
    COUNTEREXAMPLE,
    INVALID_INPUT,
    PROOF,
    UNKNOWN,
    SearchResult,
    search,
)
from .errors import PolicyError
from .spec import Spec, load_spec, parse_spec

__all__ = [
    "COUNTEREXAMPLE",
    "INVALID_INPUT",
    "PROOF",
    "UNKNOWN",
    "PolicyError",
    "SearchResult",
    "Spec",
    "load_spec",
    "parse_spec",
    "search",
]
__version__ = "0.1.0"
