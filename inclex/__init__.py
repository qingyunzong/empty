"""inclex: incremental re-lexing library and CLI."""
from .incremental import (
    Document,
    EditError,
    EditResult,
    InternalConsistencyError,
)
from .lexer import (
    STATE_IN_BLOCK_COMMENT,
    STATE_IN_LINE_COMMENT,
    STATE_IN_STRING,
    STATE_MAIN,
    LexError,
    Token,
    lex_full,
    scan_token,
)

__all__ = [
    "Document",
    "EditError",
    "EditResult",
    "InternalConsistencyError",
    "LexError",
    "Token",
    "lex_full",
    "scan_token",
    "STATE_MAIN",
    "STATE_IN_STRING",
    "STATE_IN_LINE_COMMENT",
    "STATE_IN_BLOCK_COMMENT",
]

__version__ = "0.1.0"
