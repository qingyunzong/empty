"""Edit-alignment evidence for a matched word.

Computes a minimum-cost alignment between the pattern tokens and the word
over the same product graph the search engine uses, and returns the edit
script as proof of why the word matched with the reported edit count.
"""

from __future__ import annotations

import heapq

from .pattern import STAR

INF = float("inf")


def align(tokens, word: str) -> dict:
    """Return {"edits": int, "ops": [...]} aligning tokens to word."""
    n = len(tokens)
    m = len(word)
    # Dijkstra over (token_index, word_index); costs are 0/1 and the grid is
    # tiny (d <= 2), so a plain heap is plenty.
    start = (0, 0)
    dist = {start: 0}
    parent = {}
    heap = [(0, 0, 0)]  # cost, ti, wi
    goal = (n, m)
    while heap:
        cost, ti, wi = heapq.heappop(heap)
        if cost > dist.get((ti, wi), INF):
            continue
        if (ti, wi) == goal:
            break
        for ncost, nstate, op in _transitions(tokens, word, ti, wi):
            total = cost + ncost
            if total < dist.get(nstate, INF):
                dist[nstate] = total
                parent[nstate] = ((ti, wi), op)
                heapq.heappush(heap, (total, nstate[0], nstate[1]))
    edits = dist[goal]
    ops = []
    state = goal
    while state != start:
        prev, op = parent[state]
        ops.append(op)
        state = prev
    ops.reverse()
    return {"edits": edits, "ops": ops}


def _transitions(tokens, word, ti, wi):
    n = len(tokens)
    m = len(word)
    if ti == n:
        if wi < m:
            yield 1, (ti, wi + 1), {"op": "delete", "word": word[wi]}
        return
    token = tokens[ti]
    if token.kind == STAR:
        yield 0, (ti + 1, wi), {"op": "star-empty"}
        if wi < m:
            yield 0, (ti, wi + 1), {"op": "star", "word": word[wi]}
        return
    if wi < m:
        if token.matches(word[wi]):
            op = "match" if token.kind == "literal" else "wildcard"
            yield 0, (ti + 1, wi + 1), {
                "op": op,
                "pattern": token.source,
                "word": word[wi],
            }
        else:
            yield 1, (ti + 1, wi + 1), {
                "op": "substitute",
                "pattern": token.source,
                "word": word[wi],
            }
        yield 1, (ti, wi + 1), {"op": "delete", "word": word[wi]}
    yield 1, (ti + 1, wi), {"op": "insert", "pattern": token.source}
