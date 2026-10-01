"""Error and warning types for typedbc."""


class TypedbcError(Exception):
    """Base class for all typedbc verification errors."""


class VerifyError(TypedbcError):
    """Structural verification failure.

    Raised for bad jump targets, stack underflow and stack height overflow.
    """

    def __init__(self, message, pc=None):
        super().__init__(message)
        self.pc = pc


class TypeFault(TypedbcError):
    """Instruction operand type mismatch.

    Carries pc, the expected type, the actual type found and a snapshot of
    the type stack just before the faulting instruction (top of stack last).
    """

    def __init__(self, pc, expected, actual, stack):
        self.pc = pc
        self.expected = expected
        self.actual = actual
        self.stack = list(stack)
        super().__init__(
            "TypeFault at pc %d: expected %s, got %s; stack=%s"
            % (pc, expected, actual, self.stack)
        )


class JoinError(TypedbcError):
    """CFG join point reached with mismatched type stacks."""

    def __init__(self, pc, expected, actual):
        self.pc = pc
        self.expected = list(expected)
        self.actual = list(actual)
        super().__init__(
            "JoinError at pc %d: incoming stack %s does not match %s"
            % (pc, self.actual, self.expected)
        )


class DeadType:
    """Warning record: a type problem inside unreachable (dead) code."""

    def __init__(self, pc, message, stack):
        self.pc = pc
        self.message = message
        self.stack = list(stack)

    def __str__(self):
        return "DeadType at pc %d: %s; stack=%s" % (self.pc, self.message, self.stack)
