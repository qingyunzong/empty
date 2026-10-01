"""scoper: static scope resolution for a small block-structured language."""

from .core import (
    BUILTINS,
    ERR_ASSIGN_CONST,
    ERR_DUPLICATE,
    ERR_TDZ,
    ERR_UNDEFINED,
    ScopeError,
    resolve,
)

__all__ = [
    "BUILTINS",
    "ERR_ASSIGN_CONST",
    "ERR_DUPLICATE",
    "ERR_TDZ",
    "ERR_UNDEFINED",
    "ScopeError",
    "resolve",
]

__version__ = "0.1.0"
