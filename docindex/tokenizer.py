"""Tokenization with field-relative positions, paragraphs and char spans.

Each token gets an integer position within its field instance.  A large gap
(PARAGRAPH_GAP) is inserted at paragraph boundaries (blank lines) so that
phrase and NEAR/n constraints can never span paragraphs accidentally.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

PARAGRAPH_GAP = 1000

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)
_BLANK_RE = re.compile(r"\n\s*\n")


@dataclass(frozen=True)
class Token:
    term: str        # lowercased surface form
    pos: int         # position inside the field instance (gap between paragraphs)
    paragraph: int   # 0-based paragraph index inside the field instance
    start: int       # char offset of the token in the original field text
    end: int         # char offset (exclusive) of the token in the original text


def tokenize(text: str) -> list[Token]:
    """Split *text* into tokens, preserving paragraph and span information."""
    tokens: list[Token] = []
    segments: list[tuple[int, int]] = []
    last = 0
    for match in _BLANK_RE.finditer(text):
        segments.append((last, match.start()))
        last = match.end()
    segments.append((last, len(text)))
    for paragraph, (seg_start, seg_end) in enumerate(segments):
        pos_in_para = 0
        for match in _TOKEN_RE.finditer(text, seg_start, seg_end):
            tokens.append(
                Token(
                    term=match.group(0).lower(),
                    pos=paragraph * PARAGRAPH_GAP + pos_in_para,
                    paragraph=paragraph,
                    start=match.start(),
                    end=match.end(),
                )
            )
            pos_in_para += 1
    return tokens
