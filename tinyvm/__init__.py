"""tinyvm: a small verified stack-based bytecode VM."""

from .errors import (
    EmptyHalt,
    FrameOverflow,
    RuntimeFault,
    StackOverflow,
    StepLimit,
    VMError,
)
from .program import Program, loads
from .vm import VM

__all__ = [
    "EmptyHalt",
    "FrameOverflow",
    "Program",
    "RuntimeFault",
    "StackOverflow",
    "StepLimit",
    "VM",
    "VMError",
    "loads",
]

__version__ = "1.0.0"
