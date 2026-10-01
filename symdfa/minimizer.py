"""Quotient construction, canonical numbering and proof-DAG generation."""

from __future__ import annotations

from collections import deque
from typing import Dict, List, Optional, Sequence, Tuple

from . import intervals as I
from .automaton import SymbolicDFA
from .partition import Partition

DEAD = -1  # config component for "no transition" (implicit sink)


class Minimizer:
    """Incremental symbolic-DFA minimizer.

    Holds a refined partition of the reachable states.  ``apply_changes``
    performs batch final/transition updates with incremental re-split and
    re-merge, rolling back to the previous partition and inverse index on
    any failure.
    """

    def __init__(self, dfa: SymbolicDFA):
        self.partition = Partition(dfa)

    @property
    def dfa(self) -> SymbolicDFA:
        return self.partition.dfa

    def apply_changes(
        self,
        finals: Optional[Sequence[int]] = None,
        transitions: Optional[Sequence] = None,
    ) -> None:
        self.partition.apply_changes(finals=finals, transitions=transitions)

    # ------------------------------------------------------------------
    def _block_edges(self, block: int) -> Tuple[Tuple[tuple, int], ...]:
        """Merged outgoing edges of a block: (interval_set, target_block).

        Edges are the union over all member states, merged per target
        block; stability guarantees this is deterministic."""
        part = self.partition
        merged: Dict[int, tuple] = {}
        for s in part.blocks[block]:
            for ivset, tgt in self.dfa.transitions[s]:
                tb = part.block_of[tgt]
                merged[tb] = I.union(merged.get(tb, ()), ivset)
        return tuple(sorted((ivs, tb) for tb, ivs in merged.items()))

    def canonical_numbering(self) -> Dict[int, int]:
        """Number blocks 0..k-1 by BFS from the start block, exploring each
        block's edges in sorted interval order.  This orders blocks by their
        lexicographically smallest reaching word (shorter words first) and
        never depends on set iteration order."""
        part = self.partition
        start_block = part.block_of[self.dfa.start]
        order = {start_block: 0}
        dq = deque([start_block])
        while dq:
            b = dq.popleft()
            for _ivs, tb in self._block_edges(b):
                if tb not in order:
                    order[tb] = len(order)
                    dq.append(tb)
        if len(order) != len(part.blocks):  # pragma: no cover - defensive
            raise AssertionError("unreachable block survived trimming")
        return order

    def quotient(self, numbering: Dict[int, int]) -> SymbolicDFA:
        part = self.partition
        transitions: List[list] = [[] for _ in numbering]
        finals: List[int] = []
        for block, new_id in numbering.items():
            for ivs, tb in self._block_edges(block):
                transitions[new_id].append((ivs, numbering[tb]))
            rep = min(part.blocks[block])
            if rep in self.dfa.finals:
                finals.append(new_id)
        return SymbolicDFA(
            self.dfa.alphabet_size,
            len(numbering),
            numbering[part.block_of[self.dfa.start]],
            finals,
            transitions,
        )

    # ------------------------------------------------------------------
    def build_proof_dag(self, numbering: Dict[int, int],
                        quotient: SymbolicDFA) -> dict:
        """Shared DAG of shortest distinguishing words for all state pairs
        that ended up in different blocks.

        The DAG is built on the canonically numbered quotient, so it is
        invariant under isomorphic relabelling of the input.  Nodes are
        configs (pairs of quotient states or DEAD).  An ``accept`` leaf
        means exactly one side accepts the empty word; a ``step`` node
        consumes ``char`` and continues at ``child``.  Chains are shared
        between pairs, so the structure is a DAG, not a tree.  Because
        every block is a Nerode class, a word distinguishing two quotient
        states distinguishes any two of their member states."""
        block_of_state = {s: numbering[b]
                          for s, b in self.partition.block_of.items()}
        final_blocks = quotient.finals

        def accepts_eps(side: int) -> bool:
            return side != DEAD and side in final_blocks

        def config_successors(cx: int, cy: int) -> Dict[Tuple[int, int], tuple]:
            if cx == DEAD and cy == DEAD:
                return {}
            if cx == DEAD:
                merged: Dict[Tuple[int, int], tuple] = {}
                for ivs, t in quotient.transitions[cy]:
                    merged[(DEAD, t)] = I.union(merged.get((DEAD, t), ()), ivs)
                return merged
            if cy == DEAD:
                merged = {}
                for ivs, t in quotient.transitions[cx]:
                    merged[(t, DEAD)] = I.union(merged.get((t, DEAD), ()), ivs)
                return merged
            return _pair_successors(quotient, cx, cy)

        # collect configs reachable from all cross-block state pairs
        states = sorted(block_of_state)
        seeds = set()
        for x in states:
            bx = block_of_state[x]
            for y in states:
                by = block_of_state[y]
                if bx != by:
                    seeds.add((bx, by))
        configs = set(seeds)
        queue = deque(seeds)
        while queue:
            cfg = queue.popleft()
            for nxt in config_successors(*cfg):
                if nxt[0] == nxt[1]:
                    continue
                if nxt not in configs:
                    configs.add(nxt)
                    queue.append(nxt)

        INF = float("inf")
        rank: Dict[Tuple[int, int], float] = {}
        for cfg in configs:
            if accepts_eps(cfg[0]) != accepts_eps(cfg[1]):
                rank[cfg] = 0
        changed = True
        while changed:
            changed = False
            for cfg in sorted(configs):
                if rank.get(cfg, INF) == 0:
                    continue
                best = rank.get(cfg, INF)
                for nxt in config_successors(*cfg):
                    if nxt == cfg or nxt[0] == nxt[1]:
                        continue
                    cand = rank.get(nxt, INF) + 1
                    if cand < best:
                        best = cand
                if best != rank.get(cfg, INF):
                    rank[cfg] = best
                    changed = True

        # canonical emission: node ids follow sorted config order; configs
        # with no distinguishing word (e.g. DEAD vs a dead-equivalent
        # block) can be reached but never serve a proof, so they are
        # excluded
        ordered = sorted(cfg for cfg in configs if rank.get(cfg, INF) != INF)
        cid = {cfg: i for i, cfg in enumerate(ordered)}
        nodes: List[dict] = []
        for cfg in ordered:
            nid = cid[cfg]
            if rank[cfg] == 0:
                side = 0 if accepts_eps(cfg[0]) else 1
                nodes.append({"id": nid, "kind": "accept", "side": side})
                continue
            options = []
            for nxt, ivs in sorted(config_successors(*cfg).items()):
                if nxt == cfg or nxt[0] == nxt[1]:
                    continue
                if rank.get(nxt, INF) + 1 == rank[cfg]:
                    options.append((I.pick_char(ivs), cid[nxt]))
            if not options:  # pragma: no cover - defensive
                raise AssertionError(f"config {cfg} has no distinguishing edge")
            char, child = min(options)
            nodes.append({"id": nid, "kind": "step", "char": char,
                          "child": child})

        pairs: Dict[str, int] = {}
        for i, x in enumerate(states):
            for y in states[i + 1:]:
                bx, by = block_of_state[x], block_of_state[y]
                if bx != by:
                    cfg = (bx, by)
                    if cfg not in cid:  # pragma: no cover - defensive
                        raise AssertionError(f"no proof for pair {cfg}")
                    pairs[f"{x},{y}"] = cid[cfg]
        return {"nodes": nodes, "pairs": pairs}

    # ------------------------------------------------------------------
    def result(self) -> dict:
        """Full minimization certificate."""
        numbering = self.canonical_numbering()
        quotient = self.quotient(numbering)
        block_map = {
            str(s): numbering[b] for s, b in sorted(self.partition.block_of.items())
        }
        return {
            "alphabet_size": self.dfa.alphabet_size,
            "quotient": quotient.to_dict(),
            "block_map": block_map,
            "proof_dag": self.build_proof_dag(numbering, quotient),
        }


def _pair_successors(dfa: SymbolicDFA, p: int, q: int
                     ) -> Dict[Tuple[int, int], tuple]:
    """Interval-event sweep: {(target_p|DEAD, target_q|DEAD): interval_set}
    covering the whole alphabet, without enumerating characters."""
    sigma = dfa.alphabet_size
    ev_p = sorted((lo, hi, tgt) for ivs, tgt in dfa.transitions[p]
                  for lo, hi in ivs)
    ev_q = sorted((lo, hi, tgt) for ivs, tgt in dfa.transitions[q]
                  for lo, hi in ivs)
    out: Dict[Tuple[int, int], tuple] = {}
    i = j = 0
    cur = 0
    while cur < sigma:
        tp = tq = DEAD
        hi_p = hi_q = sigma - 1
        if i < len(ev_p):
            lo, hi, tgt = ev_p[i]
            if lo <= cur:
                tp, hi_p = tgt, hi
            else:
                hi_p = lo - 1
        if j < len(ev_q):
            lo, hi, tgt = ev_q[j]
            if lo <= cur:
                tq, hi_q = tgt, hi
            else:
                hi_q = lo - 1
        hi = min(hi_p, hi_q)
        key = (tp, tq)
        out[key] = I.union(out.get(key, ()), ((cur, hi),))
        cur = hi + 1
        while i < len(ev_p) and ev_p[i][1] < cur:
            i += 1
        while j < len(ev_q) and ev_q[j][1] < cur:
            j += 1
    return out


def minimize(dfa: SymbolicDFA) -> dict:
    """One-shot full rebuild minimization."""
    return Minimizer(dfa).result()
