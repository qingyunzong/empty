"""Independent checkers used to cross-validate the automaton engine.

`wildcard_match` is a plain recursive wildcard interpreter (no edits).
`min_edits` is an independent dynamic program over (token index, word
index).  Neither shares code with the product-graph search engine, so
tests can compare the two implementations on small dictionaries.
"""

from __future__ import annotations

from functools import lru_cache

from .pattern import STAR


def wildcard_match(tokens, word: str) -> bool:
    def go(ti: int, wi: int) -> bool:
        if ti == len(tokens):
            return wi == len(word)
        token = tokens[ti]
        if token.kind == STAR:
            return any(go(ti + 1, k) for k in range(wi, len(word) + 1))
        return wi < len(word) and token.matches(word[wi]) and go(ti + 1, wi + 1)

    return go(0, 0)


def min_edits(tokens, word: str) -> int:
    @lru_cache(maxsize=None)
    def go(ti: int, wi: int) -> int:
        if ti == len(tokens):
            return len(word) - wi  # delete the remaining word chars
        token = tokens[ti]
        if token.kind == STAR:
            best = go(ti + 1, wi)  # star matches empty
            if wi < len(word):
                best = min(best, go(ti, wi + 1))  # star consumes one char
            return best
        best = go(ti + 1, wi) + 1  # insert the pattern token
        if wi < len(word):
            best = min(best, go(ti, wi + 1) + 1)  # delete the word char
            sub = 0 if token.matches(word[wi]) else 1
            best = min(best, go(ti + 1, wi + 1) + sub)
        return best

    return go(0, 0)
