"""On-demand intersection of the pattern automaton with the dictionary
automaton.

The search explores the product graph of

    dictionary position  x  pattern-NFA state

with Dijkstra (best-first) order over edit cost.  Dictionary words are
never expanded up front; the compressed automaton is walked edge by edge
as the frontier demands it.  Each frontier entry's accumulated cost is a
lower bound on the edit distance of any completion through it, so a paused
search can report a sound distance lower bound and resume later.

Transitions from (position, q) with cost c, for each dictionary char ch
leaving the position and each NFA state r in the epsilon-closure of q:

    match / wildcard / class hit   (pos+ch, r+1)  cost + 0
    substitute (non-star token)    (pos+ch, r+1)  cost + 1
    delete word char               (pos+ch, q)    cost + 1
    insert pattern token (non-star)(pos,    r+1)  cost + 1
    star consumes char             (pos+ch, r)    cost + 0

A word is accepted when a term node is reached in an NFA state whose
closure contains the accept state, with total cost <= pattern.edits.
"""

from __future__ import annotations

import heapq

from .alignment import align
from .pattern import STAR, CompiledPattern


class CursorError(ValueError):
    pass


def search(
    index,
    pattern: CompiledPattern,
    limit: int | None = None,
    budget: int | None = None,
    cursor: dict | None = None,
) -> dict:
    """Run (or resume) a search.

    Returns a JSON-able dict:
      complete  -- True only when the frontier is fully explored
      results   -- [{"word", "edits", "docs", "alignment"}...]
      cursor    -- opaque resume token, or None when complete
      stats     -- {"explored", "frontier_lower_bound"}
    """
    if limit is not None and limit < 0:
        raise ValueError("limit must be >= 0")
    if budget is not None and budget < 0:
        raise ValueError("budget must be >= 0")

    tokens = pattern.tokens
    closures = pattern.closures
    accept = pattern.accept
    max_edits = pattern.edits
    tree = index.dictionary

    best: dict[tuple[str, int], int] = {}
    heap: list = []
    emitted: set[str] = set()
    results: list[dict] = []
    explored = 0
    counter = 0

    def push(cost, prefix, q, pos):
        nonlocal counter
        if cost > max_edits:
            return
        key = (prefix, q)
        if best.get(key, max_edits + 1) <= cost:
            return
        best[key] = cost
        counter += 1
        heapq.heappush(heap, (cost, prefix, q, counter, pos))

    if cursor is None:
        push(0, "", 0, tree.initial_position())
    else:
        if cursor.get("pattern") != pattern.source:
            raise CursorError("cursor was created for a different pattern")
        if cursor.get("rules_version") != index.rules.version:
            raise CursorError("cursor was created under different normalization rules")
        emitted = set(cursor["emitted"])
        explored = cursor["explored"]
        for cost, prefix, q in cursor["frontier"]:
            try:
                pos = tree.locate(prefix)
            except KeyError:
                raise CursorError(
                    f"cursor frontier prefix {prefix!r} no longer in dictionary"
                ) from None
            push(cost, prefix, q, pos)

    explored_before = explored
    while heap:
        if budget is not None and explored - explored_before >= budget:
            break
        if limit is not None and len(results) >= limit:
            break
        cost, prefix, q, _, pos = heapq.heappop(heap)
        if best.get((prefix, q)) != cost:
            continue  # stale, dominated by a cheaper identical state
        explored += 1
        node = tree.position_node(pos)
        if (
            node is not None
            and node.is_term
            and accept in closures[q]
            and prefix not in emitted
        ):
            emitted.add(prefix)
            results.append(
                {
                    "word": prefix,
                    "edits": cost,
                    "docs": sorted(index.postings_for(prefix)),
                    "alignment": align(tokens, prefix),
                }
            )
        for ch, npos in tree.advance(pos):
            nprefix = prefix + ch
            push(cost + 1, nprefix, q, npos)  # delete word char
            for r in closures[q]:
                if r >= len(tokens):
                    continue
                token = tokens[r]
                if token.kind == STAR:
                    push(cost, nprefix, r, npos)  # star consumes the char
                elif token.matches(ch):
                    push(cost, nprefix, r + 1, npos)
                else:
                    push(cost + 1, nprefix, r + 1, npos)  # substitute
        for r in closures[q]:
            if r < len(tokens) and tokens[r].kind != STAR:
                push(cost + 1, prefix, r + 1, pos)  # insert pattern token

    complete = not heap
    next_cursor = None
    if not complete:
        frontier = sorted(
            [entry[0], entry[1], entry[2]]
            for entry in heap
            if best.get((entry[1], entry[2])) == entry[0]
        )
        next_cursor = {
            "pattern": pattern.source,
            "rules_version": index.rules.version,
            "edits": max_edits,
            "explored": explored,
            "emitted": sorted(emitted),
            "frontier": frontier,
        }
    lower_bound = min((entry[0] for entry in heap), default=None)
    return {
        "complete": complete,
        "results": results,
        "cursor": next_cursor,
        "stats": {"explored": explored, "frontier_lower_bound": lower_bound},
    }
