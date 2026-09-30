"""cegen: minimal counterexample generation over finite domains."""
from .api import find
from .errors import PolicyError
from .search import COUNTEREXAMPLE, INVALID_INPUT, PROOF, UNKNOWN

__version__ = "0.1.0"
__all__ = [
    "find",
    "PolicyError",
    "COUNTEREXAMPLE",
    "PROOF",
    "UNKNOWN",
    "INVALID_INPUT",
    "__version__",
]
