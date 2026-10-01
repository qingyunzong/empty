"""Incremental re-lexing: rescan only from the nearest safe state.

After an edit ``[start, end) -> new_text`` the token stream is repaired by
re-lexing from the start of the first token that may be affected (the
nearest safe state: main mode, not inside a string/comment), and stopping
as soon as a freshly lexed token exactly matches an old token that lies
fully beyond the edited region (same type, same text, start shifted by the
edit delta).  The remaining old tokens are then reused verbatim.

An internal assertion compares the incremental result against a full
rescan; a divergence raises :class:`InternalConsistencyError` (CLI exit
code 11).
"""
from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass

from .lexer import STATE_MAIN, LexError, Token, lex_full, scan_token


class EditError(Exception):
    """Invalid edit (out of bounds, bad types, invalid UTF-8, ...)."""

    def __init__(self, message: str, offset: int, state: str):
        super().__init__(message)
        self.message = message
        self.offset = offset
        self.state = state

    def __str__(self) -> str:
        return f"{self.message} (offset={self.offset}, state={self.state})"


class InternalConsistencyError(AssertionError):
    """Incremental result disagrees with a full rescan (exit code 11)."""


@dataclass
class EditResult:
    changed_tokens: int  # number of tokens actually re-lexed
    tokens: list[Token]  # full token stream after the edit


class Document:
    """A text document plus its token stream and per-token lexer states."""

    def __init__(self, text: str = ""):
        if not isinstance(text, str):
            raise EditError("document text must be str", 0, STATE_MAIN)
        self.text = text
        self.tokens: list[Token] = lex_full(text)

    def edit(self, start: int, end: int, new_text: str) -> EditResult:
        old = self.text
        n = len(old)
        if not isinstance(start, int) or not isinstance(end, int):
            raise EditError("edit offsets must be integers", 0, STATE_MAIN)
        if not isinstance(new_text, str):
            raise EditError("replacement text must be str", start, STATE_MAIN)
        if start < 0 or start > n:
            raise EditError("edit start out of bounds", start, STATE_MAIN)
        if end < 0 or end > n:
            raise EditError("edit end out of bounds", end, STATE_MAIN)
        if start > end:
            raise EditError("edit start is after edit end", start, STATE_MAIN)

        delta = len(new_text) - (end - start)
        new = old[:start] + new_text + old[end:]
        tokens = self.tokens

        # First token that may be affected: a token ending exactly at
        # `start` can still merge with inserted/shifted text, so it counts.
        ends = [t.end for t in tokens]
        i = bisect_left(ends, start)
        # Walk back to the nearest safe state (main mode, not inside a
        # string/comment).  Token starts are always safe in this lexer.
        while 0 < i < len(tokens) and tokens[i].state != STATE_MAIN:
            i -= 1
        if i < len(tokens):
            rescan_pos = tokens[i].start
            prefix = list(tokens[:i])
        else:
            # Edit is in trailing whitespace / at EOF: no token affected.
            rescan_pos = start
            prefix = list(tokens)

        # First old token lying fully beyond the edited region; only those
        # are eligible for reuse (shifted by delta).
        starts = [t.start for t in tokens]
        k = bisect_left(starts, end)

        fresh: list[Token] = []
        reused: list[Token] = []
        pos = rescan_pos
        while True:
            tok, pos = scan_token(new, pos)
            if tok is None:
                break
            # Old tokens whose shifted start fell behind can never match.
            while k < len(tokens) and tokens[k].start + delta < tok.start:
                k += 1
            if (
                k < len(tokens)
                and tokens[k].start + delta == tok.start
                and tokens[k].type == tok.type
                and tokens[k].text == tok.text
            ):
                # Resynchronised: the deterministic lexer would reproduce
                # exactly the remaining old tokens from this safe state.
                reused = [t.shift(delta) for t in tokens[k:]]
                break
            fresh.append(tok)

        new_tokens = prefix + fresh + reused

        # Internal assertion: must be identical to a full rescan.
        full = lex_full(new)
        if full != new_tokens:
            raise InternalConsistencyError(
                "incremental re-lex diverges from full rescan after edit "
                f"[{start},{end})"
            )

        self.text = new
        self.tokens = new_tokens
        return EditResult(changed_tokens=len(fresh), tokens=new_tokens)
