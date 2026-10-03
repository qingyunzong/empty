"""Independent NFA interpreter used to cross-check the lazy DFA.

Deliberately naive: recomputes epsilon closures by breadth-first search
at every step, sharing no code with the SCC-based closure index.
"""

from __future__ import annotations

from typing import Iterable, Set

from .nfa import NFA


def _eps_closure(nfa: NFA, states: Iterable[int]) -> Set[int]:
    seen = set(states)
    stack = list(seen)
    while stack:
        s = stack.pop()
        for e in nfa.epsilon_edges_from(s):
            if e.dst not in seen:
                seen.add(e.dst)
                stack.append(e.dst)
    return seen


def accepts(nfa: NFA, string: Iterable[int]) -> bool:
    current = _eps_closure(nfa, {nfa.start})
    for ch in string:
        nxt = set()
        for s in current:
            for e in nfa.symbol_edges_from(s):
                if e.lo <= ch <= e.hi:
                    nxt.add(e.dst)
        current = _eps_closure(nfa, nxt)
        if not current:
            return False
    return bool(current & nfa.accepting)
