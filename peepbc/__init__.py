"""peepbc: a small bytecode peephole optimiser with verification."""

from . import isa
from .interp import Result, run
from .optimize import optimize
from .program import FormatError, Ins, Program
from .verify import verify

__all__ = [
    "FormatError",
    "Ins",
    "Program",
    "Result",
    "isa",
    "optimize",
    "run",
    "verify",
]
