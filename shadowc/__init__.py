"""shadowc -- a tiny policy DSL compiler with shadow/overlap diagnostics."""

from .compiler import CompiledPolicy, Diagnostic, compile_source
from .errors import PolicyError
from .parser import parse_policy

__version__ = "0.1.0"

__all__ = [
    "CompiledPolicy",
    "Diagnostic",
    "PolicyError",
    "compile_source",
    "parse_policy",
    "__version__",
]
