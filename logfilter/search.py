"""On-demand intersection of the pattern automaton with the dictionary DAFSA.

The pattern (wildcards + character classes + edit distance d <= 2) is
interpreted as a weighted automaton whose states are (position, errors).
It is intersected with the compressed dictionary automaton by an explicit
DFS over product states (dfa_node, pos, errors, prefix): shared prefixes
are traversed once and the edit-distance state travels along.  Dictionary
words are never expanded and matched one by one.

The traversal is incremental: a `limit` caps the page size and a `budget`
caps the number of product-state expansions per call.  When the frontier
is not exhausted the result is `complete=False` and carries a cursor;
every frontier entry keeps its accumulated error count, which is a valid
lower bound on the edit distance of any hit reachable only through it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .align import align
from .normalize import CURRENT_NORMALIZATION_VERSION
from .pattern import MAX_EDIT_DISTANCE, PatternError, Star, parse_pattern


class CursorError(ValueError):
    """Raised when a resume cursor is malformed or stale."""


class NormalizationVersionError(RuntimeError):
    """Raised when the index was built with different normalization rules."""


@dataclass
class SearchResult:
    results: list
    complete: bool
    cursor: dict | None
    frontier: list
    stats: dict = field(default_factory=dict)

    def to_dict(self):
        return {
            "results": self.results,
            "complete": self.complete,
            "cursor": self.cursor,
            "frontier": self.frontier,
            "stats": self.stats,
        }


def _check_version(index):
    if index.normalization_version != CURRENT_NORMALIZATION_VERSION:
        raise NormalizationVersionError(
            "index uses normalization version "
            f"{index.normalization_version!r}, this library requires "
            f"{CURRENT_NORMALIZATION_VERSION!r}; rebuild the index"
        )


def _restore_cursor(index, cursor):
    if not isinstance(cursor, dict):
        raise CursorError("cursor must be an object")
    try:
        generation = cursor["generation"]
        pattern = cursor["pattern"]
        d = cursor["d"]
        raw_stack = cursor["stack"]
        seen_terms = set(cursor["seen_terms"])
        emitted_docs = set(cursor["emitted_docs"])
    except (KeyError, TypeError) as exc:
        raise CursorError(f"malformed cursor: missing {exc}") from None
    if generation != index.generation:
        raise CursorError("stale cursor: the index changed since it was issued")
    automaton = index.automaton
    stack = []
    for entry in raw_stack:
        try:
            prefix, pos, errors = entry
        except (TypeError, ValueError):
            raise CursorError("malformed cursor: bad frontier entry") from None
        node = automaton.walk(prefix)
        if node is None:
            raise CursorError("stale cursor: automaton no longer contains frontier")
        stack.append((node, pos, errors, prefix))
    return pattern, d, stack, seen_terms, emitted_docs


def search(index, pattern=None, d=None, limit=20, budget=None, cursor=None):
    """Search `index`; pass `cursor` (instead of `pattern`) to resume.

    Returns a SearchResult.  `complete` is True only when the frontier is
    fully explored; an incomplete result always carries a cursor.
    """
    _check_version(index)
    if limit < 1:
        raise ValueError("limit must be >= 1")
    if budget is not None and budget < 0:
        raise ValueError("budget must be >= 0")

    if cursor is not None:
        c_pattern, c_d, stack, seen_terms, emitted_docs = _restore_cursor(
            index, cursor
        )
        if pattern is not None and pattern != c_pattern:
            raise CursorError("cursor was issued for a different pattern")
        if d is not None and d != c_d:
            raise CursorError("cursor was issued for a different edit distance")
        pattern = c_pattern
        d_eff = c_d
        elements = parse_pattern(pattern).elements
    else:
        if pattern is None:
            raise ValueError("either pattern or cursor is required")
        compiled = parse_pattern(pattern)  # atomic: raises before any state
        d_eff = d if d is not None else compiled.d
        if not 0 <= d_eff <= MAX_EDIT_DISTANCE:
            raise PatternError(
                f"edit distance {d_eff} outside supported range 0..{MAX_EDIT_DISTANCE}"
            )
        elements = compiled.elements
        stack = [(index.automaton.start, 0, 0, "")]
        seen_terms = set()
        emitted_docs = set()

    automaton = index.automaton
    n = len(elements)
    # can_end[pos]: position N reachable from pos consuming nothing (stars only)
    can_end = [False] * (n + 1)
    can_end[n] = True
    for pos in range(n - 1, -1, -1):
        can_end[pos] = isinstance(elements[pos], Star) and can_end[pos + 1]

    page = {}
    order = []
    expansions = 0
    terms_hit = 0

    while stack and len(order) < limit:
        if budget is not None and expansions >= budget:
            break
        node, pos, errors, prefix = stack.pop()
        expansions += 1

        if node.terminal and can_end[pos] and prefix not in seen_terms:
            seen_terms.add(prefix)
            distance, alignment = align(elements, prefix)
            if distance <= d_eff:
                terms_hit += 1
                hit = {"term": prefix, "distance": distance, "alignment": alignment}
                for doc_id in index.postings.get(prefix, ()):
                    if doc_id in emitted_docs:
                        continue
                    if doc_id not in page:
                        page[doc_id] = []
                        order.append(doc_id)
                    page[doc_id].append(hit)

        # Epsilon moves (consume no dictionary character).
        if pos < n:
            element = elements[pos]
            if isinstance(element, Star):
                stack.append((node, pos + 1, errors, prefix))  # star matches empty
            elif errors < d_eff:
                stack.append((node, pos + 1, errors + 1, prefix))  # delete element

        # Moves consuming one dictionary character.
        for ch, nxt in automaton.sorted_edges(node):
            new_prefix = prefix + ch
            if pos < n:
                element = elements[pos]
                if isinstance(element, Star):
                    stack.append((nxt, pos, errors, new_prefix))  # star consumes ch
                else:
                    if element.matches(ch):
                        stack.append((nxt, pos + 1, errors, new_prefix))  # match
                    if errors < d_eff:
                        # substitute pattern element by ch
                        stack.append((nxt, pos + 1, errors + 1, new_prefix))
                        # insert ch (dictionary word has an extra character)
                        stack.append((nxt, pos, errors + 1, new_prefix))
            elif errors < d_eff:
                stack.append((nxt, pos, errors + 1, new_prefix))  # insert ch

    complete = not stack
    cursor_out = None
    frontier = [
        {"prefix": prefix, "pos": pos, "distance_lower_bound": errors}
        for (node, pos, errors, prefix) in stack
    ]
    if not complete:
        cursor_out = {
            "version": 1,
            "pattern": pattern,
            "d": d_eff,
            "generation": index.generation,
            "stack": [[prefix, pos, errors] for (node, pos, errors, prefix) in stack],
            "seen_terms": sorted(seen_terms),
            "emitted_docs": sorted(emitted_docs | set(order)),
        }

    results = [{"doc_id": doc_id, "terms": page[doc_id]} for doc_id in order]
    return SearchResult(
        results=results,
        complete=complete,
        cursor=cursor_out,
        frontier=frontier,
        stats={"expansions": expansions, "terms_hit": terms_hit},
    )
