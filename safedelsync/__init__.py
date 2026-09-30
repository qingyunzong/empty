"""safedelsync: safe bidirectional directory sync with delete propagation."""

from .core import CONFLICT_SUFFIX, StateError, load_state, save_state, sync

__version__ = "0.1.0"

__all__ = [
    "CONFLICT_SUFFIX",
    "StateError",
    "load_state",
    "save_state",
    "sync",
    "__version__",
]
