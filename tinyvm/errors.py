"""Exception hierarchy for tinyvm.

Each fault carries the process exit code the CLI should use, so error
categories are distinguishable from the shell (e.g. division by zero and
step-limit exhaustion exit with different codes).
"""


class VMError(Exception):
    """Load-time verification failure (bad or malicious bytecode file)."""

    exit_code = 6


class VMFault(Exception):
    """Base class for runtime faults."""

    exit_code = 5


class RuntimeFault(VMFault):
    """Generic runtime fault: div/mod by zero, stack underflow, bad pc, ..."""

    exit_code = 5


class StackOverflow(VMFault):
    """Operand stack exceeded MAX_STACK."""

    exit_code = 4


class FrameOverflow(VMFault):
    """Call frame depth exceeded MAX_FRAMES."""

    exit_code = 3


class StepLimit(VMFault):
    """Executed more than STEP_LIMIT instructions."""

    exit_code = 2


class EmptyHalt(VMFault):
    """HALT executed with an empty operand stack."""

    exit_code = 7
