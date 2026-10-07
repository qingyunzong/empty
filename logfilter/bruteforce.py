"""Independent brute-force matcher used to cross-check the automaton.

This module deliberately does NOT share code with the automaton
intersection: it interprets the pattern with a plain recursive dynamic
program over (pattern position, word position).  The test-suite uses it
on small short-alphabet dictionaries where enumerating every word and
calling a per-word matcher is affordable and trustworthy.
"""

from __future__ import annotations

from functools import lru_cache

from .pattern import Star


def bf_distance(elements, word):
    """Minimal edit distance between pattern `elements` and `word`."""

    @lru_cache(maxsize=None)
    def go(i, j):
        # cost of matching elements[:i] against word[:j]
        if i == 0:
            return j  # everything left in the word is an insertion
        element = elements[i - 1]
        if isinstance(element, Star):
            best = go(i - 1, j)  # star matches the empty string
            if j:
                best = min(best, go(i, j - 1))  # star absorbs word[j-1]
            return best
        best = go(i - 1, j) + 1  # delete the pattern element
        if j:
            best = min(best, go(i, j - 1) + 1)  # insert word[j-1]
            cost = 0 if element.matches(word[j - 1]) else 1
            best = min(best, go(i - 1, j - 1) + cost)  # match / substitute
        return best

    return go(len(elements), len(word))


def bf_matches(elements, word, d):
    return bf_distance(elements, word) <= d
