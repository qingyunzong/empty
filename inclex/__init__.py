"""inclex: an incremental re-lexing library with a small CLI."""

from .lexer import (
    EditError,
    IncrementalLexer,
    InternalConsistencyError,
    LexError,
    LexerState,
    Token,
    lex,
)

__all__ = [
    "EditError",
    "IncrementalLexer",
    "InternalConsistencyError",
    "LexError",
    "LexerState",
    "Token",
    "lex",
]

__version__ = "0.1.0"
