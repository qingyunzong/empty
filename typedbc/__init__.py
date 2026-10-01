"""typedbc: a type-stack bytecode verifier based on abstract interpretation."""

from .model import (
    Instruction,
    JoinError,
    TypeFault,
    VerificationFailure,
    VerifyError,
    parse,
)
from .verifier import (
    BOOL,
    INT,
    MAX_STACK,
    BlockInfo,
    DeadTypeWarning,
    Report,
    verify,
)

__all__ = [
    "BOOL",
    "INT",
    "MAX_STACK",
    "BlockInfo",
    "DeadTypeWarning",
    "Instruction",
    "JoinError",
    "Report",
    "TypeFault",
    "VerificationFailure",
    "VerifyError",
    "parse",
    "verify",
]

__version__ = "0.1.0"
