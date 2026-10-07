"""Edit alignment evidence between a compiled pattern and a matched word.

A small dynamic program computes the true minimal edit distance and a
concrete alignment (list of operations).  This runs only for words that
the automaton intersection already accepted, never for the whole
dictionary.
"""

from __future__ import annotations

from .pattern import Star

_INF = float("inf")


def align(elements, word):
    """Return (distance, alignment) for `elements` against `word`.

    alignment is a JSON-serializable list of operations:
      {"op": "match",      "pattern": "a",   "word": "a"}
      {"op": "substitute", "pattern": "a",   "word": "b"}
      {"op": "delete",     "pattern": "a"}
      {"op": "insert",                         "word": "b"}
      {"op": "star",       "pattern": "*",   "word": "bc"}
    """
    n, m = len(elements), len(word)
    dp = [[_INF] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0
    for j in range(1, m + 1):
        dp[0][j] = j
        back[0][j] = "ins"
    for i in range(1, n + 1):
        element = elements[i - 1]
        for j in range(0, m + 1):
            candidates = []
            if isinstance(element, Star):
                candidates.append((dp[i - 1][j], "star-empty"))
                if j:
                    candidates.append((dp[i][j - 1], "star-eat"))
            else:
                if j:
                    cost = 0 if element.matches(word[j - 1]) else 1
                    candidates.append((dp[i - 1][j - 1] + cost, "ms"))
                candidates.append((dp[i - 1][j] + 1, "del"))
                if j:
                    candidates.append((dp[i][j - 1] + 1, "ins"))
            best_cost, best_op = min(candidates, key=lambda item: item[0])
            dp[i][j] = best_cost
            back[i][j] = best_op

    ops = []
    i, j = n, m
    while i or j:
        op = back[i][j]
        if op == "ins":
            ops.append({"op": "insert", "word": word[j - 1]})
            j -= 1
        elif op == "del":
            ops.append(
                {
                    "op": "delete",
                    "pattern": elements[i - 1].describe(),
                    "element": i - 1,
                }
            )
            i -= 1
        elif op == "ms":
            element = elements[i - 1]
            kind = "match" if element.matches(word[j - 1]) else "substitute"
            ops.append(
                {
                    "op": kind,
                    "pattern": element.describe(),
                    "word": word[j - 1],
                    "element": i - 1,
                }
            )
            i -= 1
            j -= 1
        elif op == "star-empty":
            ops.append({"op": "star", "pattern": "*", "word": "", "element": i - 1})
            i -= 1
        elif op == "star-eat":
            ops.append(
                {"op": "star", "pattern": "*", "word": word[j - 1], "element": i - 1}
            )
            j -= 1
        else:  # pragma: no cover - defensive
            raise AssertionError("broken backpointer")
    ops.reverse()

    merged = []
    for op in ops:
        if (
            op["op"] == "star"
            and merged
            and merged[-1]["op"] == "star"
            and merged[-1].get("element") == op.get("element")
        ):
            merged[-1]["word"] += op["word"]
        else:
            merged.append(dict(op))
    for op in merged:
        op.pop("element", None)
    return dp[n][m], merged


def validate_alignment(elements, word, alignment):
    """Check that `alignment` is a valid proof for `word` against `elements`.

    Returns (ok, cost).  Used by the test-suite to verify hit evidence.
    """
    from .pattern import Star as _Star

    cost = 0
    elem_idx = 0
    rebuilt = []
    for op in alignment:
        kind = op.get("op")
        if kind == "match":
            if elem_idx >= len(elements):
                return False, None
            element = elements[elem_idx]
            if isinstance(element, _Star) or not element.matches(op["word"]):
                return False, None
            rebuilt.append(op["word"])
            elem_idx += 1
        elif kind == "substitute":
            if elem_idx >= len(elements):
                return False, None
            if isinstance(elements[elem_idx], _Star):
                return False, None
            rebuilt.append(op["word"])
            cost += 1
            elem_idx += 1
        elif kind == "delete":
            if elem_idx >= len(elements):
                return False, None
            if isinstance(elements[elem_idx], _Star):
                return False, None
            cost += 1
            elem_idx += 1
        elif kind == "insert":
            rebuilt.append(op["word"])
            cost += 1
        elif kind == "star":
            if elem_idx >= len(elements) or not isinstance(elements[elem_idx], _Star):
                return False, None
            rebuilt.append(op["word"])
            elem_idx += 1
        else:
            return False, None
    if elem_idx != len(elements):
        return False, None
    if "".join(rebuilt) != word:
        return False, None
    return True, cost
