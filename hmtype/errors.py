"""Error types for hmtype. Every error carries a source span and, where a
typing environment is available, a snapshot of that environment."""

from __future__ import annotations

Span = tuple[int, int, int, int]  # (start_line, start_col, end_line, end_col), 1-based


class HMError(Exception):
    kind = "Error"

    def __init__(self, message: str, span: Span | None = None,
                 env_snapshot: dict[str, str] | None = None):
        super().__init__(message)
        self.message = message
        self.span: Span = span if span is not None else (0, 0, 0, 0)
        self.env_snapshot = env_snapshot

    def to_json(self) -> dict:
        d: dict = {
            "error": self.kind,
            "message": self.message,
            "span": list(self.span),
        }
        if self.env_snapshot is not None:
            d["env_snapshot"] = dict(self.env_snapshot)
        return d


class TypeMismatch(HMError):
    kind = "TypeError"

    def __init__(self, expected: str, actual: str, span: Span,
                 env_snapshot: dict[str, str] | None = None):
        super().__init__(
            f"type mismatch: expected {expected}, got {actual}",
            span, env_snapshot)
        self.expected = expected
        self.actual = actual

    def to_json(self) -> dict:
        d = super().to_json()
        d["expected"] = self.expected
        d["actual"] = self.actual
        return d


class OccursError(HMError):
    kind = "OccursError"

    def __init__(self, var: str, in_type: str, span: Span,
                 env_snapshot: dict[str, str] | None = None):
        super().__init__(
            f"occurs check failed: cannot construct the infinite type "
            f"{var} = {in_type}",
            span, env_snapshot)
        self.var = var
        self.in_type = in_type

    def to_json(self) -> dict:
        d = super().to_json()
        d["var"] = self.var
        d["in_type"] = self.in_type
        return d


class UnboundVariable(HMError):
    kind = "UnboundVariable"

    def __init__(self, name: str, span: Span,
                 env_snapshot: dict[str, str] | None = None):
        super().__init__(f"unbound variable: {name}", span, env_snapshot)
        self.name = name

    def to_json(self) -> dict:
        d = super().to_json()
        d["name"] = self.name
        return d


class ParseError(HMError):
    kind = "ParseError"
