"""Test helpers: brute-force references over a small explicit alphabet.

Generated DFAs only carry intervals inside ``ALPHABET``; every other
character drives both machines into the implicit sink, where they agree
forever.  Restricting the reference to ``ALPHABET`` is therefore exact.
"""

from collections import deque
from itertools import product as cartesian

from symdfa import DFA

ALPHABET = (0, 1, 2, 3)


def random_dfa(rng, num_states, alphabet=ALPHABET):
    accepting = {s for s in range(num_states) if rng.random() < 0.5}
    transitions = {}
    for s in range(num_states):
        dsts = [rng.randrange(num_states) for _ in alphabet]
        ivs = []
        lo = alphabet[0]
        prev = dsts[0]
        for char, dst in zip(alphabet[1:], dsts[1:]):
            if dst != prev:
                ivs.append((lo, char - 1, prev))
                lo = char
                prev = dst
        ivs.append((lo, alphabet[-1], prev))
        transitions[s] = ivs
    return DFA(num_states, 0, accepting, transitions)


def reference_witness(dfa1, dfa2, alphabet=ALPHABET):
    """Full explicit product BFS, character by character.

    Returns the (length, lexicographically) minimal distinguishing word,
    or None if the machines agree on the whole alphabet.
    """
    def acc(dfa, s):
        return s is not None and s in dfa.accepting

    start = (dfa1.start, dfa2.start)
    if acc(dfa1, start[0]) != acc(dfa2, start[1]):
        return ()
    visited = {start}
    queue = deque([(start, ())])
    while queue:
        (p, q), path = queue.popleft()
        for char in alphabet:
            np = dfa1.step(p, char) if p is not None else None
            nq = dfa2.step(q, char) if q is not None else None
            if acc(dfa1, np) != acc(dfa2, nq):
                return path + (char,)
            if (np, nq) not in visited:
                visited.add((np, nq))
                queue.append(((np, nq), path + (char,)))
    return None


def brute_force_witness(dfa1, dfa2, max_len, alphabet=ALPHABET):
    """Exhaustively enumerate all words up to ``max_len`` in (len, lex) order."""
    for length in range(max_len + 1):
        for word in cartesian(alphabet, repeat=length):
            if dfa1.accepts(word) != dfa2.accepts(word):
                return word
    return None
