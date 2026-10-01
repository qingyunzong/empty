"""Independent certificate verifier.

Deliberately does NOT import the minimizer or partition refinement: every
check is re-derived here from the automaton, the quotient, the block map
and the proof DAG.  All checks are symbolic (interval sweeps, no
per-character expansion).
"""

from __future__ import annotations

from collections import deque
from typing import Dict, List, Optional, Tuple

from . import intervals as I
from .automaton import SymbolicDFA

DEAD = -1


def _pair_successors(dfa: SymbolicDFA, p: Optional[int], q: Optional[int]):
    """Interval-level successor configs of a state pair (None = dead)."""
    sigma = dfa.alphabet_size
    ev = []
    for side, state in ((0, p), (1, q)):
        segs = []
        if state is not None:
            for ivs, tgt in dfa.transitions[state]:
                for lo, hi in ivs:
                    segs.append((lo, hi, tgt))
        ev.append(sorted(segs))
    out: Dict[Tuple[Optional[int], Optional[int]], tuple] = {}
    i = j = 0
    cur = 0
    while cur < sigma:
        tp = tq = None
        hi_p = hi_q = sigma - 1
        if i < len(ev[0]):
            lo, hi, tgt = ev[0][i]
            if lo <= cur:
                tp, hi_p = tgt, hi
            else:
                hi_p = lo - 1
        if j < len(ev[1]):
            lo, hi, tgt = ev[1][j]
            if lo <= cur:
                tq, hi_q = tgt, hi
            else:
                hi_q = lo - 1
        hi = min(hi_p, hi_q)
        key = (tp, tq)
        out[key] = I.union(out.get(key, ()), ((cur, hi),))
        cur = hi + 1
        while i < len(ev[0]) and ev[0][i][1] < cur:
            i += 1
        while j < len(ev[1]) and ev[1][j][1] < cur:
            j += 1
    return out


def _shortest_distinguishing_length(dfa: SymbolicDFA, s: int, t: int) -> Optional[int]:
    """BFS over state-pair configs for the shortest distinguishing word."""
    def acc(x):
        return x is not None and x in dfa.finals

    if acc(s) == acc(t):
        start = (s, t)
    else:
        return 0
    seen = {start}
    queue = deque([(start, 0)])
    while queue:
        (x, y), depth = queue.popleft()
        for (nx, ny), ivs in _pair_successors(dfa, x, y).items():
            if nx is None and ny is None:
                continue
            if nx == ny:
                continue
            if acc(nx) != acc(ny):
                return depth + 1
            cfg = (nx, ny)
            if cfg not in seen:
                seen.add(cfg)
                queue.append((cfg, depth + 1))
    return None


def verify_certificate(dfa: SymbolicDFA, result: dict) -> List[str]:
    """Return a list of problems; empty means the certificate is valid."""
    errors: List[str] = []

    # ---- block map covers exactly the reachable states -----------------
    reachable = dfa.reachable_states()
    try:
        block_map = {int(s): int(b) for s, b in result["block_map"].items()}
    except (KeyError, ValueError, TypeError) as exc:
        return [f"malformed block_map: {exc}"]
    if set(block_map) != set(reachable):
        errors.append("block_map does not cover exactly the reachable states")
        return errors
    blocks: Dict[int, List[int]] = {}
    for s, b in block_map.items():
        blocks.setdefault(b, []).append(s)

    # ---- quotient structure --------------------------------------------
    try:
        quotient = SymbolicDFA.from_dict(result["quotient"])
    except (ValueError, KeyError, TypeError) as exc:
        return errors + [f"malformed quotient: {exc}"]
    if quotient.alphabet_size != dfa.alphabet_size:
        errors.append("quotient alphabet size mismatch")
    if quotient.num_states != len(blocks):
        errors.append("quotient state count != number of blocks")
    if set(blocks) != set(range(quotient.num_states)):
        errors.append("block ids are not a contiguous 0..k-1 numbering")
    if quotient.start != block_map.get(dfa.start):
        errors.append("quotient start is not the start state's block")

    # finality: a block is final iff all its members are final
    for b, members in blocks.items():
        expected = all(m in dfa.finals for m in members)
        if any(m in dfa.finals for m in members) != expected:
            errors.append(f"block {b} mixes final and non-final states")
        if (b in quotient.finals) != expected:
            errors.append(f"block {b} finality mismatch with quotient")

    # transition stability of the claimed partition (partial-DFA semantics)
    # (a) union of member edges per target block must be deterministic
    # (b) union edges must match the quotient edges exactly
    # (c) where a member is undefined but the block moves to B', B' must be
    #     dead-equivalent (cannot reach a final block in the quotient)
    union_edges: Dict[int, Dict[int, tuple]] = {}
    for b, members in blocks.items():
        acc: Dict[int, tuple] = {}
        seen: tuple = ()
        for s in members:
            for ivs, tgt in dfa.transitions[s]:
                tb = block_map[tgt]
                overlap = I.intersect(seen, I.subtract(ivs, acc.get(tb, ())))
                if overlap:
                    errors.append(
                        f"block {b}: character(s) {overlap} sent to multiple "
                        f"blocks by different members"
                    )
                acc[tb] = I.union(acc.get(tb, ()), ivs)
                seen = I.union(seen, ivs)
        union_edges[b] = acc
        for qivs, qb in quotient.transitions[b]:
            if not I.is_subset(qivs, acc.get(qb, ())) or \
                    not I.is_subset(acc.get(qb, ()), qivs):
                errors.append(
                    f"quotient edge {qivs}->{qb} of block {b} does not match "
                    f"the union of member edges"
                )
        if len(quotient.transitions[b]) != len(acc):
            errors.append(f"block {b}: quotient edge count mismatch")

    can_accept = set(quotient.finals)
    changed = True
    while changed:
        changed = False
        for b, acc in union_edges.items():
            if b not in can_accept and any(tb in can_accept for tb in acc):
                can_accept.add(b)
                changed = True
    for b, members in blocks.items():
        for s in members:
            cov: tuple = ()
            for ivs, _tgt in dfa.transitions[s]:
                cov = I.union(cov, ivs)
            for tb, ivs in union_edges[b].items():
                excess = I.subtract(ivs, cov)
                if excess and tb in can_accept:
                    errors.append(
                        f"block {b}: state {s} undefined on {excess} but "
                        f"block moves to live block {tb}"
                    )

    # ---- canonical numbering: BFS by sorted interval order -------------
    if not errors:
        order = {quotient.start: 0}
        dq = deque([quotient.start])
        while dq:
            b = dq.popleft()
            for _ivs, tb in quotient.transitions[b]:
                if tb not in order:
                    order[tb] = len(order)
                    dq.append(tb)
        if sorted(order.values()) != list(range(quotient.num_states)) or \
                any(order[b] != b for b in order):
            errors.append("quotient numbering is not the canonical "
                          "shortest-word BFS order")

    # ---- proof DAG -------------------------------------------------------
    dag = result.get("proof_dag", {})
    nodes = dag.get("nodes", [])
    pairs = dag.get("pairs", {})
    for nid, node in enumerate(nodes):
        if node.get("id") != nid or node.get("kind") not in ("accept", "step"):
            errors.append(f"malformed DAG node {nid}")
        if node.get("kind") == "step":
            c = node.get("char")
            if not isinstance(c, int) or not 0 <= c < dfa.alphabet_size:
                errors.append(f"DAG node {nid} has invalid char")
            if not isinstance(node.get("child"), int) or \
                    not 0 <= node.get("child", -1) < len(nodes):
                errors.append(f"DAG node {nid} has invalid child")

    states = sorted(reachable)
    expected_pairs = set()
    for i, x in enumerate(states):
        for y in states[i + 1:]:
            if block_map[x] != block_map[y]:
                expected_pairs.add(f"{x},{y}")
    if set(pairs) != expected_pairs:
        errors.append("proof DAG does not cover exactly the unmerged pairs")

    # DAG chains are walked on the quotient (blocks are Nerode classes, so
    # a word distinguishing two quotient states distinguishes any members)
    def qstep(x: Optional[int], c: int) -> Optional[int]:
        return None if x is None else quotient.step(x, c)

    def walk(bx: int, by: int, nid: int) -> Tuple[Optional[int], Optional[str]]:
        x: Optional[int] = bx
        y: Optional[int] = by
        length = 0
        seen = set()
        while True:
            if nid in seen:
                return None, "cycle in proof DAG"
            seen.add(nid)
            if not isinstance(nid, int) or nid >= len(nodes):
                return None, "dangling node id"
            node = nodes[nid]
            if node["kind"] == "accept":
                ax = x is not None and x in quotient.finals
                ay = y is not None and y in quotient.finals
                if ax == ay:
                    return None, "accept leaf but both sides agree"
                if node.get("side") != (0 if ax else 1):
                    return None, "accept leaf names the wrong side"
                return length, None
            c = node["char"]
            x = qstep(x, c)
            y = qstep(y, c)
            if x is None and y is None:
                return None, "both sides die before the word distinguishes"
            nid = node["child"]
            length += 1

    for key, nid in pairs.items():
        if not isinstance(nid, int) or not 0 <= nid < len(nodes):
            errors.append(f"pair {key} references missing node")
            continue
        s, t = (int(v) for v in key.split(","))
        length, err = walk(block_map[s], block_map[t], nid)
        if err:
            errors.append(f"pair {key}: {err}")
            continue
        # independent minimality check via our own BFS oracle on the
        # quotient (never calls the minimizer)
        best = _shortest_distinguishing_length(
            quotient, block_map[s], block_map[t]
        )
        if best is None:
            errors.append(f"pair {key}: blocks are actually equivalent")
        elif best != length:
            errors.append(
                f"pair {key}: DAG word length {length} != shortest {best}"
            )
    return errors

    blocks: Dict[int, List[int]] = {}
    for s, b in block_map.items():
        blocks.setdefault(b, []).append(s)

    # ---- quotient structure --------------------------------------------
    try:
        quotient = SymbolicDFA.from_dict(result["quotient"])
    except (ValueError, KeyError, TypeError) as exc:
        return errors + [f"malformed quotient: {exc}"]
    if quotient.alphabet_size != dfa.alphabet_size:
        errors.append("quotient alphabet size mismatch")
    if quotient.num_states != len(blocks):
        errors.append("quotient state count != number of blocks")
    if set(blocks) != set(range(quotient.num_states)):
        errors.append("block ids are not a contiguous 0..k-1 numbering")
    if quotient.start != block_map.get(dfa.start):
        errors.append("quotient start is not the start state's block")

    # finality: a block is final iff all its members are final
    for b, members in blocks.items():
        expected = all(m in dfa.finals for m in members)
        if any(m in dfa.finals for m in members) != expected:
            errors.append(f"block {b} mixes final and non-final states")
        if (b in quotient.finals) != expected:
            errors.append(f"block {b} finality mismatch with quotient")

    # transition stability of the claimed partition (partial-DFA semantics)
    # (a) union of member edges per target block must be deterministic
    # (b) union edges must match the quotient edges exactly
    # (c) where a member is undefined but the block moves to B', B' must be
    #     dead-equivalent (cannot reach a final block in the quotient)
    union_edges: Dict[int, Dict[int, tuple]] = {}
    for b, members in blocks.items():
        acc: Dict[int, tuple] = {}
        seen: tuple = ()
        for s in members:
            for ivs, tgt in dfa.transitions[s]:
                tb = block_map[tgt]
                overlap = I.intersect(seen, I.subtract(ivs, acc.get(tb, ())))
                if overlap:
                    errors.append(
                        f"block {b}: character(s) {overlap} sent to multiple "
                        f"blocks by different members"
                    )
                acc[tb] = I.union(acc.get(tb, ()), ivs)
                seen = I.union(seen, ivs)
        union_edges[b] = acc
        for qivs, qb in quotient.transitions[b]:
            if not I.is_subset(qivs, acc.get(qb, ())) or \
                    not I.is_subset(acc.get(qb, ()), qivs):
                errors.append(
                    f"quotient edge {qivs}->{qb} of block {b} does not match "
                    f"the union of member edges"
                )
        if len(quotient.transitions[b]) != len(acc):
            errors.append(f"block {b}: quotient edge count mismatch")

    can_accept = set(quotient.finals)
    changed = True
    while changed:
        changed = False
        for b, acc in union_edges.items():
            if b not in can_accept and any(tb in can_accept for tb in acc):
                can_accept.add(b)
                changed = True
    for b, members in blocks.items():
        for s in members:
            cov: tuple = ()
            for ivs, _tgt in dfa.transitions[s]:
                cov = I.union(cov, ivs)
            for tb, ivs in union_edges[b].items():
                excess = I.subtract(ivs, cov)
                if excess and tb in can_accept:
                    errors.append(
                        f"block {b}: state {s} undefined on {excess} but "
                        f"block moves to live block {tb}"
                    )

    # ---- canonical numbering: BFS by sorted interval order -------------
    if not errors:
        order = {quotient.start: 0}
        dq = deque([quotient.start])
        while dq:
            b = dq.popleft()
            for _ivs, tb in quotient.transitions[b]:
                if tb not in order:
                    order[tb] = len(order)
                    dq.append(tb)
        if sorted(order.values()) != list(range(quotient.num_states)) or \
                any(order[b] != b for b in order):
            errors.append("quotient numbering is not the canonical "
                          "shortest-word BFS order")

    # ---- proof DAG -------------------------------------------------------
    dag = result.get("proof_dag", {})
    nodes = dag.get("nodes", [])
    pairs = dag.get("pairs", {})
    for nid, node in enumerate(nodes):
        if node.get("id") != nid or node.get("kind") not in ("accept", "step"):
            errors.append(f"malformed DAG node {nid}")
        if node.get("kind") == "step":
            c = node.get("char")
            if not isinstance(c, int) or not 0 <= c < dfa.alphabet_size:
                errors.append(f"DAG node {nid} has invalid char")
            if not isinstance(node.get("child"), int) or \
                    not 0 <= node.get("child", -1) < len(nodes):
                errors.append(f"DAG node {nid} has invalid child")

    states = sorted(reachable)
    expected_pairs = set()
    for i, x in enumerate(states):
        for y in states[i + 1:]:
            if block_map[x] != block_map[y]:
                expected_pairs.add(f"{x},{y}")
    if set(pairs) != expected_pairs:
        errors.append("proof DAG does not cover exactly the unmerged pairs")

    def walk(s: int, t: int, nid: int) -> Tuple[Optional[int], Optional[str]]:
        """Follow the chain; returns (word_length, error)."""
        x, y = s, t
        length = 0
        seen = set()
        while True:
            if nid in seen:
                return None, "cycle in proof DAG"
            seen.add(nid)
            if nid >= len(nodes):
                return None, "dangling node id"
            node = nodes[nid]
            if node["kind"] == "accept":
                ax = x is not None and x in dfa.finals
                ay = y is not None and y in dfa.finals
                if ax == ay:
                    return None, "accept leaf but both sides agree"
                if node.get("side") != (0 if ax else 1):
                    return None, "accept leaf names the wrong side"
                return length, None
            c = node["char"]
            x = None if x is None else dfa.step(x, c)
            y = None if y is None else dfa.step(y, c)
            if x is None and y is None:
                return None, "both sides die before the word distinguishes"
            nid = node["child"]
            length += 1

    for key, nid in pairs.items():
        if not isinstance(nid, int) or not 0 <= nid < len(nodes):
            errors.append(f"pair {key} references missing node")
            continue
        s, t = (int(v) for v in key.split(","))
        length, err = walk(s, t, nid)
        if err:
            errors.append(f"pair {key}: {err}")
            continue
        # independent minimality check via our own BFS oracle
        best = _shortest_distinguishing_length(dfa, s, t)
        if best is None:
            errors.append(f"pair {key}: states are actually equivalent")
        elif best != length:
            errors.append(
                f"pair {key}: DAG word length {length} != shortest {best}"
            )
    return errors
