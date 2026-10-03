"""Independent brute-force checkers used to validate the optimised solver.

These implementations deliberately avoid the solver's lower-bound pruning
and budget machinery so the unit tests can cross-check optimal depths and
witness lengths against a straightforward enumeration.
"""
from __future__ import annotations

from collections import deque
from itertools import product


def min_adaptive_depth(machine, initials):
    """Minimum worst-case depth of an adaptive distinguishing tree.

    Plain memoised recursion over candidate configurations; returns ``None``
    when no strategy tree exists.
    """
    memo = {}

    def rec(config, ancestors):
        if len(config) <= 1:
            return 0
        if config in memo:
            return memo[config]
        best = None
        for inp in machine.inputs:
            blocks = {}
            merged = False
            for init, cur in config:
                out = machine.output(cur, inp)
                nxt = machine.successor(cur, inp)
                block = blocks.setdefault(out, [])
                if any(nxt == other for _, other in block):
                    merged = True
                    break
                block.append((init, nxt))
            if merged:
                continue
            worst = 0
            for block in blocks.values():
                sub_key = tuple(sorted(block))
                if sub_key in ancestors:
                    worst = None
                    break
                sub = rec(sub_key, ancestors | {config})
                if sub is None:
                    worst = None
                    break
                worst = max(worst, sub)
            if worst is not None:
                cand = 1 + worst
                if best is None or cand < best:
                    best = cand
        memo[config] = best
        return best

    root = tuple(sorted((s, s) for s in initials))
    return rec(root, frozenset())


def min_preset_length(machine, initials, max_len):
    """Minimum preset distinguishing sequence length by full enumeration."""
    initials = list(initials)
    if len(initials) <= 1:
        return 0, []
    for length in range(max_len + 1):
        for seq in product(machine.inputs, repeat=length):
            signatures = [
                tuple(machine.simulate_outputs(s, seq)) for s in initials
            ]
            if len(set(signatures)) == len(signatures):
                return length, list(seq)
    return None, None


def pairwise_witness_length(machine, s, t, max_len):
    """Shortest sequence separating two states, by forward BFS."""
    if s == t:
        return None
    seen = {(s, t)}
    queue = deque([((s, t), 0)])
    while queue:
        (cur_s, cur_t), depth = queue.popleft()
        if depth >= max_len:
            continue
        for inp in machine.inputs:
            if machine.output(cur_s, inp) != machine.output(cur_t, inp):
                return depth + 1
            ns = machine.successor(cur_s, inp)
            nt = machine.successor(cur_t, inp)
            if ns != nt and (ns, nt) not in seen:
                seen.add((ns, nt))
                queue.append(((ns, nt), depth + 1))
    return None
