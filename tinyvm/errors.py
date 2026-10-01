"""Exception hierarchy for tinyvm.

Exit-code mapping is defined in tinyvm/__main__.py:

- VMError        -> 6  (load/verify failure)
- RuntimeFault   -> 3  (generic runtime fault, e.g. division by zero)
- EmptyHalt      -> 5  (HALT with empty operand stack)
- StackOverflow  -> 7  (operand stack limit exceeded)
- FrameOverflow  -> 8  (call frame limit exceeded)
- StepLimit      -> 9  (instruction step limit exceeded)
"""


class VMError(Exception):
    """Raised while loading/verifying a bytecode file."""


class RuntimeFault(Exception):
    """Raised for deterministic runtime failures.

    Carries the pc and step count at the point of failure so the
    machine state is fully reproducible.
    """

    exit_code = 3

    def __init__(self, message, pc=None, step=None):
        self.pc = pc
        self.step = step
        location = ""
        if pc is not None and step is not None:
            location = " at pc=%d step=%d" % (pc, step)
        super().__init__(message + location)


class EmptyHalt(RuntimeFault):
    """HALT executed with an empty operand stack."""

    exit_code = 5


class StackOverflow(RuntimeFault):
    """Operand stack limit exceeded."""

    exit_code = 7


class FrameOverflow(RuntimeFault):
    """Call frame limit exceeded."""

    exit_code = 8


class StepLimit(RuntimeFault):
    """Instruction step limit exceeded."""

    exit_code = 9
