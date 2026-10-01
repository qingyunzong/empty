"""tinyvm: a small verified stack-based bytecode VM."""

from .errors import (
    EmptyHalt,
    FrameOverflow,
    RuntimeFault,
    StackOverflow,
    StepLimit,
    VMError,
    VMFault,
)
from .loader import Program, dump_program, load
from .vm import MAX_FRAMES, MAX_STACK, STEP_LIMIT, VM

__all__ = [
    "EmptyHalt",
    "FrameOverflow",
    "MAX_FRAMES",
    "MAX_STACK",
    "Program",
    "RuntimeFault",
    "STEP_LIMIT",
    "StackOverflow",
    "StepLimit",
    "VM",
    "VMError",
    "VMFault",
    "dump_program",
    "load",
]

__version__ = "1.0.0"
