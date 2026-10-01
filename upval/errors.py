"""Error types for upval with exit-code classification.

Compile errors exit with code 10, runtime errors with code 9.
Every error serializes to a JSON dict carrying ``var``, ``level`` and
``span`` (where applicable).
"""

COMPILE_ERROR_EXIT = 10
RUNTIME_ERROR_EXIT = 9


class UpvalError(Exception):
    """Base class for all upval errors."""

    exit_code = 1

    def to_dict(self):
        raise NotImplementedError


class CompileError(UpvalError):
    """A static (compile-time) error: exit code 10."""

    kind = "CompileError"
    exit_code = COMPILE_ERROR_EXIT

    def __init__(self, var=None, level=None, span=None, message=None):
        self.var = var
        self.level = level
        self.span = tuple(span) if span is not None else None
        self.message = message or self.kind
        super().__init__(self.message)

    def to_dict(self):
        return {
            "error": self.kind,
            "var": self.var,
            "level": self.level,
            "span": list(self.span) if self.span is not None else None,
            "message": self.message,
        }


class FreeVarError(CompileError):
    """Reference to a variable that is not defined in any visible scope."""

    kind = "FreeVar"


class DuplicateDefError(CompileError):
    """A ``let``/parameter redefines a name already visible (any level)."""

    kind = "DuplicateDef"


class ParseError(CompileError):
    """Syntax error."""

    kind = "ParseError"


class LexError(CompileError):
    """Lexical error."""

    kind = "LexError"


class UpvalRuntimeError(UpvalError):
    """A runtime failure: exit code 9."""

    kind = "RuntimeError"
    exit_code = RUNTIME_ERROR_EXIT

    def __init__(self, reason, message, span=None, var=None, level=None):
        self.reason = reason
        self.message = message
        self.span = tuple(span) if span is not None else None
        self.var = var
        self.level = level
        super().__init__(message)

    def to_dict(self):
        return {
            "error": self.kind,
            "reason": self.reason,
            "var": self.var,
            "level": self.level,
            "span": list(self.span) if self.span is not None else None,
            "message": self.message,
        }
