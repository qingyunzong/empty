"""Tokenization rules for the synthetic corpus (the only tokenizer in use).

Rules, applied in order:

1. Documents are decoded as UTF-8 (handled by the reader; ``tokenize``
   receives ``str``).
2. The text is case-folded with ``str.casefold()``.
3. A token is a maximal run of characters ``c`` where ``c.isalnum()`` is
   true (Unicode letters and decimal digits; this includes CJK ideographs,
   so "搜索" is a single token).
4. Every other character (whitespace, punctuation, symbols) is a separator
   and never appears inside a token.
5. Tokens are emitted in order of appearance; duplicates are kept so that
   document lengths and total token counts are reproducible.
"""
from __future__ import annotations


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    current: list[str] = []
    for ch in text.casefold():
        if ch.isalnum():
            current.append(ch)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return tokens
