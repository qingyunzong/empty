"""bmc: a tiny bounded model checker for integer transition systems."""

from .engine import ERROR, E_READ, SAFE_BOUNDED, VIOLATION, check
from .model import ModelError, load_model

__all__ = [
    "check",
    "load_model",
    "ModelError",
    "VIOLATION",
    "SAFE_BOUNDED",
    "ERROR",
    "E_READ",
]

__version__ = "0.1.0"
