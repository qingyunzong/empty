"""Independent verifier.

Two kinds of artefacts can be checked without trusting the prover:

* ``verify_proof`` re-derives every relation item from the machines and
  checks that the relation covers the start pair and is closed under the
  segmented transitions;
* ``verify_witness`` replays a counterexample word character by character
  (through the implicit sink) and checks the final acceptance mismatch.
"""

from __future__ import annotations

from .dfa import DFA
from .product import (
    SINK, partition_segments, is_mismatch,
    MODE_EQUIVALENCE, MODE_INCLUSION,
)
from .proof import Proof


def _accept(dfa: DFA, state) -> bool:
    return state is not SINK and state in dfa.accepting


def verify_proof(proof: Proof, dfa1: DFA, dfa2: DFA):
    """Item-by-item coverage check.  Returns ``(ok, reason)``."""
    if proof.mode not in (MODE_EQUIVALENCE, MODE_INCLUSION):
        return False, f"unknown mode {proof.mode!r}"
    if proof.version1 != dfa1.version or proof.version2 != dfa2.version:
        return False, (
            f"version mismatch: proof bound to "
            f"({proof.version1}, {proof.version2}), machines are "
            f"({dfa1.version}, {dfa2.version})"
        )
    table = {}
    for item in proof.items:
        if item.pair in table:
            return False, f"duplicate relation item for pair {item.pair}"
        table[item.pair] = item
    start = (dfa1.start, dfa2.start)
    if start not in table:
        return False, "start pair not covered by relation"
    for item in proof.items:
        p, q = item.pair
        if is_mismatch(proof.mode, dfa1, dfa2, p, q):
            return False, f"acceptance mismatch at pair {item.pair}"
        expected = tuple(partition_segments(dfa1, dfa2, p, q))
        if tuple(item.segments) != expected:
            return False, f"segment mismatch at pair {item.pair}"
        for lo, hi, d1, d2 in item.segments:
            if d1 is SINK and d2 is SINK:
                continue
            if (d1, d2) not in table:
                return False, (
                    f"coverage gap: successor ({d1}, {d2}) of pair "
                    f"{item.pair} missing from relation"
                )
    return True, "ok"


def verify_witness(word, dfa1: DFA, dfa2: DFA, mode: str = MODE_EQUIVALENCE):
    """Replay ``word`` character by character.  Returns ``(ok, reason)``."""
    p, q = dfa1.start, dfa2.start
    for char in word:
        p = p if p is SINK else dfa1.step(p, char)
        q = q if q is SINK else dfa2.step(q, char)
        if p is not SINK and not (0 <= p < dfa1.num_states):
            return False, "replay left machine 1 state space"
        if q is not SINK and not (0 <= q < dfa2.num_states):
            return False, "replay left machine 2 state space"
    if not is_mismatch(mode, dfa1, dfa2, p, q):
        return False, "word does not exhibit the claimed mismatch"
    return True, "ok"
