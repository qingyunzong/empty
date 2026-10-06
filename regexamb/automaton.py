"""Branch-labelled position automaton and the synchronised pair product.

The Glushkov automaton labels every transition with the literal node
(branch) it originates from.  A run of the automaton on a word
corresponds one-to-one to a sequence of literal positions, which -- for
expressions where every node has at most one empty-word parse and no
star wraps a nullable child -- corresponds one-to-one to a parse tree.

Ambiguity of the automaton is decided by exploring the synchronised
product of the automaton with itself: two runs on the same word are
tracked as a pair of states plus a flag recording whether the runs have
diverged.  The expression is automaton-ambiguous iff a divergent pair of
final states is reachable.
"""
from __future__ import annotations

from collections import deque

from .properties import firstpos, lastpos, followpos, literals


def nfa_ambiguity(root) -> tuple[bool, dict]:
    """Return ``(ambiguous, stats)`` for the position automaton of ``root``."""
    lits = literals(root)
    first = firstpos(root)
    last = set(lastpos(root))
    follow = followpos(root)
    alphabet = sorted(set(lits.values()))

    def succ(state, char):
        # state None is the unique start state; otherwise a position id.
        if state is None:
            return [p for p in first if lits[p] == char]
        return [q for q in follow.get(state, ()) if lits[q] == char]

    start = (None, None, False)
    seen = {start}
    queue = deque([start])
    while queue:
        p, q, diverged = queue.popleft()
        for char in alphabet:
            for p2 in succ(p, char):
                for q2 in succ(q, char):
                    div2 = diverged or p2 != q2
                    if div2 and p2 in last and q2 in last:
                        stats = {"positions": len(lits), "pair_states": len(seen)}
                        return True, stats
                    state = (p2, q2, div2)
                    if state not in seen:
                        seen.add(state)
                        queue.append(state)
    stats = {"positions": len(lits), "pair_states": len(seen)}
    return False, stats
