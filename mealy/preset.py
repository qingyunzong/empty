"""Breadth-first search for a preset (non-adaptive) distinguishing sequence."""
from __future__ import annotations

from collections import deque


def min_preset_sequence(machine, initials, max_len):
    """Shortest preset input sequence separating all of ``initials``.

    Returns the sequence as a list, or ``None`` when no sequence of length
    at most ``max_len`` distinguishes every pair of the set.  A single
    sequence qualifies iff the output sequences of all candidate states are
    pairwise distinct.
    """
    initials = list(initials)
    if len(initials) <= 1:
        return []
    queue = deque([()])
    while queue:
        seq = queue.popleft()
        if len(seq) > max_len:
            return None
        signatures = [tuple(machine.simulate_outputs(s, seq)) for s in initials]
        if len(set(signatures)) == len(signatures):
            return list(seq)
        for inp in machine.inputs:
            queue.append(seq + (inp,))
    return None
