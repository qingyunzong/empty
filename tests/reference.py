"""Independent regex-based reference scanner used by the tests.

Deliberately implemented separately from ``inclex.lexer`` (regex master
pattern instead of a hand-written state machine) so the randomised tests
compare two independent implementations.
"""
from __future__ import annotations

import re

TOKEN_RE = re.compile(
    r"""
      (?P<IDENT>[A-Za-z_][A-Za-z0-9_]*)
    | (?P<NUMBER>[0-9]+(?:\.[0-9]+)?)
    | (?P<STRING>"(?:\\[^\n]|[^"\\\n])*"|'(?:\\[^\n]|[^'\\\n])*')
    | (?P<LINE_COMMENT>//[^\n]*)
    | (?P<OP>==|!=|<=|>=|&&|\|\||\+=|-=|\*=|/=|\+\+|--|->|<<|>>
           |[-+*/%=<>!&|^~()\[\]{};,.:?])
    | (?P<WS>\s+)
    """,
    re.VERBOSE,
)


class RefLexError(Exception):
    def __init__(self, offset: int, state: str):
        super().__init__(f"offset={offset} state={state}")
        self.offset = offset
        self.state = state


def reference_lex(text: str):
    """Return [(type, text, start, end), ...] or raise RefLexError."""
    tokens = []
    pos = 0
    n = len(text)
    while pos < n:
        if text.startswith("/*", pos):
            close = text.find("*/", pos + 2)
            if close == -1:
                raise RefLexError(pos, "in_block_comment")
            tokens.append(("BLOCK_COMMENT", text[pos:close + 2], pos,
                           close + 2))
            pos = close + 2
            continue
        m = TOKEN_RE.match(text, pos)
        if m is None:
            c = text[pos]
            if c == '"' or c == "'":
                raise RefLexError(pos, "in_string")
            raise RefLexError(pos, "main")
        pos = m.end()
        if m.lastgroup == "WS":
            continue
        tokens.append((m.lastgroup, m.group(), m.start(), m.end()))
    return tokens
