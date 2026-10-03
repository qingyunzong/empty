"""Core lexer and incremental re-lexing engine for inclex.

The lexer recognizes a small, C-like token set:

* identifiers      ``[A-Za-z_][A-Za-z0-9_]*``
* numbers          ``[0-9]+`` or ``[0-9]+.[0-9]+``
* strings          ``"..."`` with backslash escapes, no raw newlines
* line comments    ``// ...`` up to (not including) the newline
* block comments   ``/* ... */`` may span lines, never nest
* operators        two-char ops (``== != <= >= && || += -= *= /= ->``)
                   and single-char punctuation

Whitespace separates tokens and is not part of the token stream.

Every token records the lexer state at its start.  A state is *safe*
when it is the main mode (i.e. the scanner is not inside a string or a
comment).  After an edit, re-lexing starts at the nearest safe state at
or before the first affected token and stops as soon as the freshly
scanned stream re-synchronizes with the old one.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class LexerState(Enum):
    """Lexer mode at a given source position."""

    MAIN = "main"
    IN_STRING = "in_string"
    IN_BLOCK_COMMENT = "in_block_comment"
    IN_LINE_COMMENT = "in_line_comment"

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return self.value


class LexError(Exception):
    """Raised for unterminated constructs or unexpected characters.

    Carries the character ``offset`` where the problem was detected and
    the lexer ``state`` at that point.
    """

    def __init__(self, message: str, offset: int, state: LexerState) -> None:
        self.offset = offset
        self.state = state
        super().__init__(f"{message} (offset={offset}, state={state})")


class EditError(Exception):
    """Raised for invalid edits or invalid input bytes.

    Carries the offending character ``offset`` and the lexer ``state``
    (always ``main`` for edit/encoding problems).
    """

    def __init__(
        self, message: str, offset: int, state: LexerState = LexerState.MAIN
    ) -> None:
        self.offset = offset
        self.state = state
        super().__init__(f"{message} (offset={offset}, state={state})")


class InternalConsistencyError(AssertionError):
    """Incremental re-lexing disagreed with a full re-lex (exit code 11)."""


@dataclass(frozen=True)
class Token:
    """One lexed token.  ``state`` is the lexer state at ``start``."""

    type: str
    start: int
    end: int
    value: str
    state: LexerState = LexerState.MAIN


_MULTI_OPS = ("==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "->")
_SINGLE_OPS = frozenset("+-*/=<>!&|(){}[];,.:")
_WHITESPACE = frozenset(" \t\r\n")
_IDENT_START = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
)
_IDENT_PART = frozenset(_IDENT_START | set("0123456789"))
_DIGITS = frozenset("0123456789")


def _skip_ws(source: str, pos: int, n: int) -> int:
    while pos < n and source[pos] in _WHITESPACE:
        pos += 1
    return pos


def _scan_token(source: str, pos: int) -> Token:
    """Scan exactly one token starting at ``pos`` (a non-ws position)."""
    n = len(source)
    ch = source[pos]

    if ch in _IDENT_START:
        end = pos + 1
        while end < n and source[end] in _IDENT_PART:
            end += 1
        return Token("IDENT", pos, end, source[pos:end])

    if ch in _DIGITS:
        end = pos
        while end < n and source[end] in _DIGITS:
            end += 1
        if end + 1 < n and source[end] == "." and source[end + 1] in _DIGITS:
            end += 2
            while end < n and source[end] in _DIGITS:
                end += 1
        return Token("NUMBER", pos, end, source[pos:end])

    if ch == '"':
        i = pos + 1
        while i < n:
            c = source[i]
            if c == "\\":
                i += 2
                continue
            if c == '"':
                return Token("STRING", pos, i + 1, source[pos : i + 1])
            if c == "\n":
                break
            i += 1
        raise LexError("unterminated string literal", pos, LexerState.IN_STRING)

    if ch == "/" and pos + 1 < n:
        nxt = source[pos + 1]
        if nxt == "/":
            end = pos + 2
            while end < n and source[end] != "\n":
                end += 1
            return Token("LINE_COMMENT", pos, end, source[pos:end])
        if nxt == "*":
            close = source.find("*/", pos + 2)
            if close == -1:
                raise LexError(
                    "unterminated block comment", pos, LexerState.IN_BLOCK_COMMENT
                )
            return Token("BLOCK_COMMENT", pos, close + 2, source[pos : close + 2])

    for op in _MULTI_OPS:
        if source.startswith(op, pos):
            return Token("OP", pos, pos + 2, op)
    if ch in _SINGLE_OPS:
        return Token("OP", pos, pos + 1, ch)

    raise LexError(f"unexpected character {ch!r}", pos, LexerState.MAIN)


def lex(source: str) -> list[Token]:
    """Lex ``source`` completely and return the token stream."""
    tokens: list[Token] = []
    pos = 0
    n = len(source)
    while True:
        pos = _skip_ws(source, pos, n)
        if pos >= n:
            return tokens
        token = _scan_token(source, pos)
        tokens.append(token)
        pos = token.end


class IncrementalLexer:
    """Maintains a token stream across small source edits.

    ``apply_edit(start, end, text)`` replaces ``source[start:end]`` with
    ``text`` and re-lexes only the necessary suffix: scanning resumes at
    the nearest safe (main-mode) token state at or before the edit and
    stops as soon as a freshly scanned token matches an old token that
    lies entirely past the edited region, after which the remaining old
    tokens are reused (shifted by the edit delta).
    """

    def __init__(self, source: str = "") -> None:
        self._source = ""
        self._tokens: list[Token] = []
        self.set_text(source)

    @property
    def source(self) -> str:
        return self._source

    @property
    def tokens(self) -> list[Token]:
        return list(self._tokens)

    def set_text(self, source: str) -> None:
        self._tokens = lex(source)
        self._source = source

    def apply_edit(self, start: int, end: int, text: str) -> int:
        """Apply ``source[start:end] = text``; return changed token count."""
        old = self._source
        n = len(old)
        if not 0 <= start <= n:
            raise EditError("edit start out of bounds", start)
        if not start <= end <= n:
            raise EditError("edit end out of bounds", end)
        new_source = old[:start] + text + old[end:]
        delta = len(text) - (end - start)
        new_tokens, changed = self._relex(new_source, start, end, delta)
        # Safety net: the incremental result must equal a full re-lex.
        full = lex(new_source)
        if full != new_tokens:
            raise InternalConsistencyError(
                "incremental re-lex diverged from full re-lex "
                f"after edit [{start}, {end})"
            )
        self._source = new_source
        self._tokens = new_tokens
        return changed

    def _relex(
        self, new_source: str, start: int, end: int, delta: int
    ) -> tuple[list[Token], int]:
        old_tokens = self._tokens

        # A token is guaranteed unchanged only when every character the
        # scanner consulted while producing it is untouched.  Scanning
        # consults the terminator at token.end; numbers consult one more
        # character (a digit after a trailing "." may merge, e.g. "1.5").
        # Inserting at EOF also counts: it replaces the EOF terminator.
        idx = 0
        while idx < len(old_tokens):
            t = old_tokens[idx]
            lookahead = 2 if t.type == "NUMBER" else 1
            if t.end + lookahead <= start:
                idx += 1
            else:
                break

        # Back up to the nearest safe (main-mode) token state.
        while (
            idx > 0
            and idx < len(old_tokens)
            and old_tokens[idx].state is not LexerState.MAIN
        ):
            idx -= 1

        kept = old_tokens[:idx]
        # Resume at the nearest safe state at or before the first
        # affected token: the end of the last kept token (main mode).
        # The edit may start in the whitespace gap before that token, so
        # resuming at the affected token's old start would skip changes.
        pos = kept[-1].end if kept else 0

        new_tokens: list[Token] = list(kept)
        changed = 0
        n_new = len(new_source)
        j = idx  # next old token eligible for reuse
        while True:
            pos = _skip_ws(new_source, pos, n_new)
            if pos >= n_new:
                break
            if j < len(old_tokens):
                tj = old_tokens[j]
                tj_start_new = tj.start + delta
                if tj_start_new < pos:
                    j += 1
                    continue
                if (
                    tj_start_new == pos
                    and tj.end >= end
                    and new_source.startswith(tj.value, pos)
                ):
                    # Re-synchronized: this token and everything after it
                    # is the shared, unedited suffix; reuse shifted.
                    new_tokens.append(
                        Token(tj.type, pos, pos + len(tj.value), tj.value, tj.state)
                    )
                    for k in range(j + 1, len(old_tokens)):
                        tk = old_tokens[k]
                        new_tokens.append(
                            Token(
                                tk.type,
                                tk.start + delta,
                                tk.end + delta,
                                tk.value,
                                tk.state,
                            )
                        )
                    break
            token = _scan_token(new_source, pos)
            new_tokens.append(token)
            changed += 1
            pos = token.end
        return new_tokens, changed
