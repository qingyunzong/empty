"""peepbc: safe peephole optimizer for G3-style stack bytecode."""
from .interp import Result, run
from .model import Instr, ParseError, Program, dump, parse
from .optimize import optimize
from .verify import verify

__all__ = [
    "Instr",
    "ParseError",
    "Program",
    "Result",
    "dump",
    "optimize",
    "parse",
    "run",
    "verify",
]
