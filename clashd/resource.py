"""Resource patterns: specificity ordering and segment-wise matching.

A pattern is a ``/``-separated path. Each segment is matched with
``fnmatch.fnmatchcase`` (so ``*``, ``?`` and ``[...]`` work inside a
segment). The special segment ``**`` matches zero or more whole
segments. Segment counts must otherwise be equal.

Specificity is a totally ordered tuple ``(exact, literal, -wild)``:
more exact segments win, then more literal characters, then fewer
wildcard characters. Equal tuples fall through to the rule_id
tiebreak in the compiler.
"""

import fnmatch

_WILD_CHARS = "*?["


def specificity(pattern):
    """Return a comparable specificity tuple for a resource pattern."""
    segments = pattern.split("/")
    exact = sum(1 for s in segments if not any(c in s for c in _WILD_CHARS))
    literal = sum(1 for c in pattern if c not in "*?[]!")
    wild = sum(1 for c in pattern if c in _WILD_CHARS)
    return (exact, literal, -wild)


def match_resource(pattern, resource):
    """Return True if ``resource`` matches ``pattern`` segment-wise."""
    return _match(pattern.split("/"), resource.split("/"))


def _match(pseg, rseg):
    if not pseg:
        return not rseg
    head = pseg[0]
    if head == "**":
        rest = pseg[1:]
        return any(_match(rest, rseg[i:]) for i in range(len(rseg) + 1))
    if not rseg:
        return False
    if not fnmatch.fnmatchcase(rseg[0], head):
        return False
    return _match(pseg[1:], rseg[1:])
