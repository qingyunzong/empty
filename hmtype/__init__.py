"""hmtype: Hindley-Milner type inference for a mini ML-like language."""

from .errors import (HMError, OccursError, ParseError, TypeMismatch,
                     UnboundVariable)
from .infer import MAX_ERRORS, Infer, infer_expr, infer_program
from .syntax import parse_expr, parse_program
from .types import type_str

__all__ = [
    "HMError", "OccursError", "ParseError", "TypeMismatch", "UnboundVariable",
    "MAX_ERRORS", "Infer", "infer_expr", "infer_program",
    "parse_expr", "parse_program", "type_str",
]


def infer_source(src: str) -> str:
    """Infer the principal type of a single expression given as source."""
    from .syntax import parse_expr as _parse
    return type_str(infer_expr(_parse(src)))
