"""Independent set-based NFA interpreter used to cross-check the DFA.

Deliberately does not reuse ClosureIndex: it computes epsilon closures
with a plain per-query breadth-first search so that a bug in the shared
closure machinery cannot be masked by the checker using the same code.
"""
from __future__ import annotations

from .nfa import NFA


def eps_closure(nfa: NFA, states) -> frozenset[int]:
    seen = set(states)
    stack = list(states)
    while stack:
        s = stack.pop()
        for e in nfa.epsilon_edges(s):
            if e.dst not in seen:
                seen.add(e.dst)
                stack.append(e.dst)
    return frozenset(seen)


def accepts(nfa: NFA, symbols) -> bool:
    current = eps_closure(nfa, {nfa.start})
    for sym in symbols:
        nxt = set()
        for s in current:
            for e in nfa.symbol_edges(s):
                if e.lo <= sym <= e.hi:
                    nxt.add(e.dst)
        current = eps_closure(nfa, nxt)
    return bool(current & nfa.finals)
