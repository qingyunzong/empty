"""Tokenization rules for the synthetic document collection.

The rules are deliberately simple and fully specified (see README.md):

1. Input text is decoded as UTF-8 and normalized with Unicode NFKC
   (full-width forms such as "ＡＢＣ" fold to "ABC").
2. The normalized text is case-folded with ``str.casefold()``.
3. A *word character* is any character whose Unicode general category
   starts with ``L`` (letter) or ``N`` (number). Everything else
   (whitespace, punctuation, symbols, underscores, ...) is a separator.
4. A maximal run of word characters forms the tokens, except that Han
   ideographs (CJK Unified Ideographs and Extension A / Compatibility)
   are emitted as single-character tokens, while contiguous non-Han
   letters/digits stay together.
"""
from __future__ import annotations

import unicodedata


def _is_word_char(ch: str) -> bool:
    return unicodedata.category(ch)[0] in ("L", "N")


def _is_han(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0xF900 <= cp <= 0xFAFF
    )


def tokenize(text: str) -> list[str]:
    """Split *text* into tokens according to the rules above."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    tokens: list[str] = []
    buf: list[str] = []

    def flush_run() -> None:
        if not buf:
            return
        sub: list[str] = []
        for ch in buf:
            if _is_han(ch):
                if sub:
                    tokens.append("".join(sub))
                    sub = []
                tokens.append(ch)
            else:
                sub.append(ch)
        if sub:
            tokens.append("".join(sub))
        buf.clear()

    for ch in normalized:
        if _is_word_char(ch):
            buf.append(ch)
        else:
            flush_run()
    flush_run()
    return tokens
