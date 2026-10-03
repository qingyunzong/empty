"""Independent verifier for equivalence / inclusion certificates.

A proof is a relation over product states: every entry pairs one state of
each machine (None = implicit sink) and lists product edges whose intervals
must tile the whole alphabet [0, 65535].  The verifier recomputes everything
from the machine definitions and checks the relation item by item:

* the proof is bound to the exact machine versions,
* the initial pair is covered,
* every entry satisfies the acceptance condition,
* every entry's edges tile [0, 65535] without gaps or overlaps,
* every edge is consistent with both machines' transitions,
* every edge's successor pair is itself covered by an entry.

A counterexample certificate is verified by replaying the word character by
character on both machines.
"""

from __future__ import annotations

from .explore import EQUIVALENCE, INCLUSION
from .machine import MAX_CHAR

_PROOF_TYPES = {"equivalence_proof": EQUIVALENCE, "inclusion_proof": INCLUSION}


def _valid_side(machine, state):
    return state is None or state in machine.states


def _edge_consistent(machine, state, lo, hi, target):
    """Check that ``machine`` moves ``state`` --[lo, hi]--> ``target``."""
    if state is None:
        return target is None
    for mlo, mhi, mtarget in machine.intervals(state):
        if mlo > hi:
            break
        if mhi < lo:
            continue
        # The machine has an interval overlapping [lo, hi]: it must cover
        # the whole segment and lead to ``target``.
        return target is not None and mlo <= lo and mhi >= hi and mtarget == target
    return target is None


def entry_edges_consistent(a, b, pair, edges):
    """Local check of one proof entry; returns a list of error strings."""
    errors = []
    pa, pb = pair
    expect_lo = 0
    for edge in edges:
        lo, hi, nxt = edge
        if lo != expect_lo:
            errors.append(
                f"entry {list(pair)}: gap or overlap before lo={lo} "
                f"(expected {expect_lo})")
        if not (0 <= lo <= hi <= MAX_CHAR):
            errors.append(f"entry {list(pair)}: bad interval [{lo}, {hi}]")
        expect_lo = hi + 1
        na, nb = nxt
        if not _valid_side(a, na) or not _valid_side(b, nb):
            errors.append(f"entry {list(pair)}: edge to unknown state {list(nxt)}")
        if not _edge_consistent(a, pa, lo, hi, na):
            errors.append(
                f"entry {list(pair)}: edge [{lo}, {hi}] inconsistent with machine A")
        if not _edge_consistent(b, pb, lo, hi, nb):
            errors.append(
                f"entry {list(pair)}: edge [{lo}, {hi}] inconsistent with machine B")
    if expect_lo != MAX_CHAR + 1:
        errors.append(
            f"entry {list(pair)}: edges do not cover [0, {MAX_CHAR}] "
            f"(stop at {expect_lo - 1})")
    return errors


def verify_proof(a, b, proof):
    """Verify an equivalence/inclusion proof; returns a list of errors."""
    errors = []
    if not isinstance(proof, dict):
        return ["proof is not a JSON object"]
    mode = _PROOF_TYPES.get(proof.get("type"))
    if mode is None:
        return [f"unknown proof type {proof.get('type')!r}"]
    if proof.get("version_a") != a.version:
        errors.append(
            f"proof bound to machine A version {proof.get('version_a')}, "
            f"current version is {a.version}")
    if proof.get("version_b") != b.version:
        errors.append(
            f"proof bound to machine B version {proof.get('version_b')}, "
            f"current version is {b.version}")
    entries = proof.get("entries")
    if not isinstance(entries, list):
        errors.append("proof has no entry list")
        return errors

    by_pair = {}
    for entry in entries:
        raw = entry.get("pair")
        if not isinstance(raw, list) or len(raw) != 2:
            errors.append(f"malformed pair {raw!r}")
            continue
        pair = (raw[0], raw[1])
        if not _valid_side(a, pair[0]) or not _valid_side(b, pair[1]):
            errors.append(f"entry {raw}: unknown state")
            continue
        if pair in by_pair:
            errors.append(f"duplicate entry for pair {raw}")
            continue
        acc_a = a.is_accepting(pair[0])
        acc_b = b.is_accepting(pair[1])
        if mode == EQUIVALENCE and acc_a != acc_b:
            errors.append(f"entry {raw}: acceptance mismatch")
        if mode == INCLUSION and acc_a and not acc_b:
            errors.append(f"entry {raw}: A accepts but B rejects")
        edges = []
        for e in entry.get("edges", []):
            nxt = e.get("next")
            if not isinstance(nxt, list) or len(nxt) != 2:
                errors.append(f"entry {raw}: malformed edge {e!r}")
                continue
            edges.append((e.get("lo"), e.get("hi"), (nxt[0], nxt[1])))
        errors.extend(entry_edges_consistent(a, b, pair, edges))
        by_pair[pair] = edges

    initial = (a.initial, b.initial)
    if initial not in by_pair:
        errors.append("initial pair not covered by the relation")
    for pair, edges in by_pair.items():
        for lo, hi, nxt in edges:
            if nxt not in by_pair:
                errors.append(
                    f"entry {list(pair)}: successor {list(nxt)} not covered")
    return errors


def verify_counterexample(a, b, cert, mode=None):
    """Replay a counterexample word on both machines; returns errors."""
    errors = []
    if not isinstance(cert, dict):
        return ["counterexample is not a JSON object"]
    mode = mode or cert.get("mode", EQUIVALENCE)
    word = cert.get("word")
    if not isinstance(word, list) or not all(
            isinstance(c, int) and 0 <= c <= MAX_CHAR for c in word):
        return [f"invalid word {word!r}"]
    acc_a = a.accepts(word)
    acc_b = b.accepts(word)
    if "accepts_a" in cert and cert["accepts_a"] != acc_a:
        errors.append("claimed accepts_a does not match replay")
    if "accepts_b" in cert and cert["accepts_b"] != acc_b:
        errors.append("claimed accepts_b does not match replay")
    if mode == EQUIVALENCE and acc_a == acc_b:
        errors.append("word is accepted equally by both machines")
    if mode == INCLUSION and not (acc_a and not acc_b):
        errors.append("word does not witness L(A) \\ L(B)")
    return errors
