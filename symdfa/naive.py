"""Naive reference oracle: pairwise equivalence fixpoint with explicit
per-character expansion.  Only used by the test-suite as a cross-check;
never used by the minimizer itself."""

from __future__ import annotations

from typing import Dict, List, Tuple

from .automaton import SymbolicDFA

DEAD = -1


def naive_partition(dfa: SymbolicDFA) -> Tuple[Tuple[int, ...], ...]:
    """Coarsest equivalence over reachable states, computed by iterating a
    pairwise-equivalence relation to a fixed point."""
    states = sorted(dfa.reachable_states())
    sigma = dfa.alphabet_size
    # per-character expansion (reference implementation only)
    succ: Dict[int, List[int]] = {DEAD: [DEAD] * sigma}
    for s in states:
        succ[s] = [
            dfa.step(s, c) if dfa.step(s, c) is not None else DEAD
            for c in range(sigma)
        ]
    universe = states + [DEAD]
    final = set(dfa.finals)

    def is_final(x: int) -> bool:
        return x in final  # DEAD is non-final

    eq = {
        (x, y)
        for x in universe
        for y in universe
        if is_final(x) == is_final(y)
    }
    while True:
        new_eq = {
            (x, y)
            for (x, y) in eq
            if all(
                (succ[x][c], succ[y][c]) in eq or succ[x][c] == succ[y][c]
                for c in range(sigma)
            )
        }
        if new_eq == eq:
            break
        eq = new_eq
    blocks: List[Tuple[int, ...]] = []
    seen = set()
    for s in states:
        if s in seen:
            continue
        block = tuple(sorted(t for t in states if (s, t) in eq))
        blocks.append(block)
        seen.update(block)
    return tuple(sorted(blocks))
