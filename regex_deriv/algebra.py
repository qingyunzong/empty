"""Language operations on regexes via derivative product construction.

All search procedures perform a BFS over pairs of derivative states:

  equivalent(a, b)          L(a) == L(b)
  included(a, b)            L(a) subset of L(b)
  shortest_difference(a, b) shortest (then lexicographically smallest)
                            string in the symmetric difference

When a state budget is given and exhausted, the result has status
"unknown" and carries a serializable frontier.  The frontier is bound to
the exact expressions and alphabet via a SHA-256 token; resuming with
different expressions/alphabet raises ValueError.  Unexplored frontier
states are never treated as counterexamples or as proof.

An exhaustive search yields a proof: a bisimulation-style graph of state
pairs that can be independently checked with `verify_proof`.
"""
from __future__ import annotations

import hashlib
import json as _json
from collections import deque

from .derivative import derive, partition
from .syntax import from_json, nullable, to_json

OP_OF_MODE = {
    "equivalent": "equivalent",
    "difference": "shortest_difference",
    "included": "included",
}
MODE_OF_OP = {v: k for k, v in OP_OF_MODE.items()}


def match(node, s, alphabet):
    """Derivative-based matching.  Characters outside the alphabet never
    match (complement is defined relative to the alphabet)."""
    for ch in s:
        cp = ord(ch)
        if not alphabet.contains(cp):
            return False
        node = derive(node, cp)
    return nullable(node)


def binding_token(op, a, b, alphabet):
    """Stable token binding an operation to its expressions and alphabet."""
    payload = _json.dumps(
        {"op": op, "a": to_json(a), "b": to_json(b),
         "alphabet": alphabet.to_json()},
        sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _unknown(mode, a, b, alphabet, visited, queue, explored,
             proof_states, proof_trans):
    return {
        "status": "unknown",
        "explored": explored,
        "frontier": {
            "op": OP_OF_MODE[mode],
            "binding": binding_token(OP_OF_MODE[mode], a, b, alphabet),
            "visited": [[to_json(x), to_json(y)] for (x, y) in visited],
            "queue": [
                {"state": [to_json(p[0]), to_json(p[1])], "prefix": pfx}
                for (p, pfx) in queue
            ],
            "proof": {"states": proof_states, "transitions": proof_trans},
        },
    }


def _bfs(mode, a, b, alphabet, max_states, visited, queue, explored,
         proof_states, proof_index, proof_trans):
    def pid(pair):
        idx = proof_index.get(pair)
        if idx is None:
            idx = len(proof_states)
            proof_index[pair] = idx
            proof_states.append([to_json(pair[0]), to_json(pair[1])])
        return idx

    while queue:
        (na, nb), prefix = queue.popleft()
        if max_states is not None and explored >= max_states:
            queue.appendleft(((na, nb), prefix))
            return _unknown(mode, a, b, alphabet, visited, queue, explored,
                            proof_states, proof_trans)
        explored += 1
        sid = pid((na, nb))
        nula, nulb = nullable(na), nullable(nb)
        if mode == "included":
            bad = nula and not nulb
        else:
            bad = nula != nulb
        if bad:
            witness = "".join(map(chr, prefix))
            status = {"equivalent": "not_equivalent",
                      "difference": "different",
                      "included": "not_included"}[mode]
            return {"status": status, "witness": witness,
                    "explored": explored}
        for lo, hi in partition(alphabet, na, nb):
            pair = (derive(na, lo), derive(nb, lo))
            proof_trans.append([sid, lo, hi, pid(pair)])
            if pair not in visited:
                visited.add(pair)
                queue.append((pair, prefix + [lo]))
    status = {"equivalent": "equivalent",
              "difference": "equivalent",
              "included": "included"}[mode]
    proof = {"mode": mode, "start": proof_index[(a, b)],
             "states": proof_states, "transitions": proof_trans}
    return {"status": status, "proof": proof, "explored": explored}


def _resume(mode, a, b, alphabet, frontier, max_states):
    op = OP_OF_MODE[mode]
    if frontier.get("op") != op or \
            frontier.get("binding") != binding_token(op, a, b, alphabet):
        raise ValueError(
            "frontier binding mismatch: the frontier was not produced for "
            "these expressions, alphabet and operation")
    visited = {(from_json(x), from_json(y))
               for x, y in frontier["visited"]}
    queue = deque(
        ((from_json(e["state"][0]), from_json(e["state"][1])),
         list(e["prefix"]))
        for e in frontier["queue"])
    pj = frontier.get("proof", {})
    proof_states = [list(s) for s in pj.get("states", [])]
    proof_index = {(from_json(s[0]), from_json(s[1])): i
                   for i, s in enumerate(proof_states)}
    proof_trans = [list(t) for t in pj.get("transitions", [])]
    return _bfs(mode, a, b, alphabet, max_states, visited, queue,
                frontier.get("explored", 0),
                proof_states, proof_index, proof_trans)


def _search(mode, a, b, alphabet, max_states, frontier):
    if frontier is not None:
        return _resume(mode, a, b, alphabet, frontier, max_states)
    return _bfs(mode, a, b, alphabet, max_states,
                {(a, b)}, deque([((a, b), [])]), 0, [], {}, [])


def equivalent(a, b, alphabet, max_states=None, frontier=None):
    """Decide L(a) == L(b).  Result status is one of "equivalent" (with a
    "proof" graph), "not_equivalent" (with a shortest "witness"), or
    "unknown" (budget exhausted, with a resumable "frontier")."""
    return _search("equivalent", a, b, alphabet, max_states, frontier)


def shortest_difference(a, b, alphabet, max_states=None, frontier=None):
    """Shortest (ties broken lexicographically) string accepted by exactly
    one of the expressions, or an equivalence proof if none exists."""
    return _search("difference", a, b, alphabet, max_states, frontier)


def included(a, b, alphabet, max_states=None, frontier=None):
    """Decide L(a) subset of L(b).  Status "included" (with proof),
    "not_included" (with shortest witness in L(a) \\ L(b)), or "unknown"."""
    return _search("included", a, b, alphabet, max_states, frontier)


def _merge(intervals):
    out = []
    for lo, hi in sorted(intervals):
        if out and lo <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return out


def verify_proof(a, b, alphabet, proof):
    """Independently verify an equivalence/inclusion proof graph.

    Checks that the start state is exactly (a, b), that every reachable
    state's nullability agrees with the claimed relation, that each
    state's transitions form an exact, disjoint cover of the alphabet,
    that every transition interval is uniform (contained in one atomic
    partition cell of both expressions), and that transition targets match
    the actual derivatives.  A proof migrated from different expressions
    or tampered in any state/transition fails verification.
    """
    try:
        mode = proof.get("mode", "equivalent")
        states = [(from_json(s[0]), from_json(s[1]))
                  for s in proof["states"]]
        start = proof["start"]
        transitions = proof["transitions"]
    except (KeyError, IndexError, TypeError, ValueError):
        return False
    if not states or not (0 <= start < len(states)):
        return False
    if states[start] != (a, b):
        return False
    trans_by_state = {}
    for t in transitions:
        try:
            i, lo, hi, j = t
        except (TypeError, ValueError):
            return False
        if not (0 <= i < len(states) and 0 <= j < len(states)):
            return False
        if lo > hi:
            return False
        trans_by_state.setdefault(i, []).append((lo, hi, j))
    seen = set()
    stack = [start]
    while stack:
        i = stack.pop()
        if i in seen:
            continue
        seen.add(i)
        na, nb = states[i]
        if mode == "included":
            if nullable(na) and not nullable(nb):
                return False
        else:
            if nullable(na) != nullable(nb):
                return False
        trs = sorted(trans_by_state.get(i, []))
        if not trs:
            return False
        for k in range(1, len(trs)):
            if trs[k][0] <= trs[k - 1][1]:
                return False  # overlapping intervals
        if _merge([(lo, hi) for lo, hi, _ in trs]) != \
                list(alphabet.intervals()):
            return False  # transitions must cover the alphabet exactly
        atoms = partition(alphabet, na, nb)
        for lo, hi, j in trs:
            if not any(al <= lo and hi <= ah for al, ah in atoms):
                return False  # interval not uniform for both expressions
            if (derive(na, lo), derive(nb, lo)) != states[j]:
                return False
            stack.append(j)
    return True
