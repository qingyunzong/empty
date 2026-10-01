"""typedbc: a type-stack verifier for a tiny stack bytecode."""

from .errors import DeadType, JoinError, TypedbcError, TypeFault, VerifyError
from .isa import BOOL, INT, OPS, Instruction, parse
from .verifier import (
    MAX_STACK_HEIGHT,
    BlockInfo,
    VerifyResult,
    result_to_json,
    verify,
)

__version__ = "0.1.0"
__all__ = [
    "BOOL",
    "INT",
    "OPS",
    "BlockInfo",
    "DeadType",
    "Instruction",
    "JoinError",
    "MAX_STACK_HEIGHT",
    "TypedbcError",
    "TypeFault",
    "VerifyError",
    "VerifyResult",
    "parse",
    "result_to_json",
    "verify",
]
