"""Error types for the upval language.

Every error carries an optional ``var`` (variable name), ``level``
(function nesting level, top level is 0) and ``span``
``(start_line, start_col, end_line, end_col)`` so the CLI can emit
structured diagnostics.
"""


class UpvalError(Exception):
    kind = "Error"
    exit_code = 1

    def __init__(self, message, var=None, level=None, span=None):
        super().__init__(message)
        self.message = message
        self.var = var
        self.level = level
        self.span = span

    def to_dict(self):
        span = None
        if self.span is not None:
            sl, sc, el, ec = self.span
            span = {
                "start_line": sl,
                "start_col": sc,
                "end_line": el,
                "end_col": ec,
            }
        return {
            "error": self.kind,
            "message": self.message,
            "var": self.var,
            "level": self.level,
            "span": span,
        }


class CompileError(UpvalError):
    exit_code = 10


class ParseError(CompileError):
    kind = "ParseError"


class FreeVar(CompileError):
    kind = "FreeVar"


class DuplicateDef(CompileError):
    kind = "DuplicateDef"


class RuntimeFailure(UpvalError):
    exit_code = 9


class ArityError(RuntimeFailure):
    kind = "ArityError"


class NotCallable(RuntimeFailure):
    kind = "NotCallable"


class TypeMismatch(RuntimeFailure):
    kind = "TypeError"


class DivZero(RuntimeFailure):
    kind = "DivZero"


class UninitializedVar(RuntimeFailure):
    kind = "UninitializedVar"
