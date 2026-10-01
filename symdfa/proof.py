"""Shared proof DAG of shortest distinguishing words.

For every pair of blocks of the minimized automaton we compute a shortest
word accepted from exactly one side.  Nodes are keyed by block pairs so
suffixes shared between pairs are represented once (a DAG, not a tree).
"""
from __future__ import annotations

from .dfa import InverseIndex


class ProofDAG:
    def __init__(self, nodes, roots):
        # nodes: list of {"pair": (i, j), "char": int | None, "child": id | None}
        self.nodes = nodes
        self.roots = roots  # (i, j) with i < j -> node id

    def word(self, i, j):
        """Shortest distinguishing word for the block pair (i, j)."""
        key = (i, j) if i < j else (j, i)
        node_id = self.roots[key]
        word = []
        while True:
            node = self.nodes[node_id]
            if node["char"] is None:
                return word
            word.append(node["char"])
            node_id = node["child"]

    def to_dict(self):
        return {
            "nodes": [
                {
                    "id": node_id,
                    "pair": [node["pair"][0], node["pair"][1]],
                    "char": node["char"],
                    "child": node["child"],
                }
                for node_id, node in enumerate(self.nodes)
            ],
            "roots": {
                f"{i},{j}": node_id
                for (i, j), node_id in sorted(self.roots.items())
            },
        }


def build_proof_dag(canon):
    """Build the DAG for a canonical minimized automaton.

    Reverse BFS over the block-pair product graph, driven purely by inverse
    interval events: a pair (p, q) is distinguished at depth d+1 by char c
    when (delta(p, c), delta(q, c)) is distinguished at depth d.  Depth 0
    pairs are those whose finality differs (empty word).
    """
    n = len(canon.states)
    inv = InverseIndex.build(canon)
    depth = {}
    char_of = {}
    child_pair = {}
    frontier = []
    for i in range(n):
        for j in range(i + 1, n):
            if (i in canon.finals) != (j in canon.finals):
                depth[(i, j)] = 0
                frontier.append((i, j))
    level = 0
    while frontier:
        candidates = {}
        for i, j in frontier:
            for lo1, hi1, p in inv.by_target.get(i, ()):
                for lo2, hi2, q in inv.by_target.get(j, ()):
                    if p == q:
                        continue
                    lo = max(lo1, lo2)
                    hi = min(hi1, hi2)
                    if lo > hi:
                        continue
                    pred = (p, q) if p < q else (q, p)
                    if pred in depth:
                        continue
                    if pred not in candidates or lo < candidates[pred][0]:
                        candidates[pred] = (lo, (i, j))
        next_frontier = []
        for pred in sorted(candidates):
            char, child = candidates[pred]
            depth[pred] = level + 1
            char_of[pred] = char
            child_pair[pred] = child
            next_frontier.append(pred)
        frontier = next_frontier
        level += 1
    if len(depth) != n * (n - 1) // 2:
        raise AssertionError("automaton is not minimal; proof DAG incomplete")
    # Deterministic node numbering: by (depth, pair).
    ordered = sorted(depth, key=lambda pair: (depth[pair], pair))
    node_id = {pair: k for k, pair in enumerate(ordered)}
    nodes = []
    for pair in ordered:
        if depth[pair] == 0:
            nodes.append({"pair": pair, "char": None, "child": None})
        else:
            nodes.append(
                {
                    "pair": pair,
                    "char": char_of[pair],
                    "child": node_id[child_pair[pair]],
                }
            )
    roots = {pair: node_id[pair] for pair in ordered}
    return ProofDAG(nodes, roots)
