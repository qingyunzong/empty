"""upval: a tiny closure language with escape analysis and shared cells.

Pipeline: parse -> resolve (scope resolution + escape analysis) -> run.
A separate explicit-environment reference interpreter is provided for
cross-checking.
"""

from .errors import (
    COMPILE_ERROR_EXIT,
    RUNTIME_ERROR_EXIT,
    CompileError,
    DuplicateDefError,
    FreeVarError,
    LexError,
    ParseError,
    UpvalError,
    UpvalRuntimeError,
)
from .evaluator import Evaluator, format_value, run
from .parser import parse
from .reference import ReferenceInterpreter, interpret
from .resolver import Analysis, Resolver, resolve

__version__ = "0.1.0"

__all__ = [
    "Analysis",
    "COMPILE_ERROR_EXIT",
    "RUNTIME_ERROR_EXIT",
    "CompileError",
    "DuplicateDefError",
    "Evaluator",
    "FreeVarError",
    "LexError",
    "ParseError",
    "ReferenceInterpreter",
    "Resolver",
    "UpvalError",
    "UpvalRuntimeError",
    "format_value",
    "interpret",
    "parse",
    "resolve",
    "run",
]
