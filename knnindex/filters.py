"""Boolean label filters with exact, conservative evaluation against summaries.

A filter is a JSON-able dict:

    {"tag": "a"}                          membership
    {"not": <expr>}                       negation
    {"and": [<expr>, ...]}                conjunction
    {"or":  [<expr>, ...]}                disjunction
    {"all": true} / {"none": true}        constants

``evaluate`` answers for a single label set.  ``evaluate_summary`` answers for
a node summary (``present`` = union of tags held by points in the subtree,
``absent`` = union of tags missing from points in the subtree) and returns
``True``/``False`` only when the answer is certain for *every* point in the
subtree; otherwise it returns ``None`` ("unknown") so the caller must descend.
Returning ``False`` is the only pruning signal and it is always safe: a tag is
certainly absent everywhere only when it is not in ``present`` at all.
"""

from typing import FrozenSet, Optional


def evaluate(expr, labels: FrozenSet[str]) -> bool:
    if "all" in expr:
        return True
    if "none" in expr:
        return False
    if "tag" in expr:
        return expr["tag"] in labels
    if "not" in expr:
        return not evaluate(expr["not"], labels)
    if "and" in expr:
        return all(evaluate(e, labels) for e in expr["and"])
    if "or" in expr:
        return any(evaluate(e, labels) for e in expr["or"])
    raise ValueError(f"invalid filter expression: {expr!r}")


def evaluate_summary(expr, present: FrozenSet[str], absent: FrozenSet[str]) -> Optional[bool]:
    """Tri-state evaluation of ``expr`` against a node tag summary.

    ``present``: tags held by at least one point in the subtree.
    ``absent``:  tags missing from at least one point in the subtree.
    For a single point the two sets are disjoint and every tag is decided;
    for internal nodes they may overlap, which yields ``None`` (unknown).
    """
    if "all" in expr:
        return True
    if "none" in expr:
        return False
    if "tag" in expr:
        tag = expr["tag"]
        if tag not in present:
            return False  # no point in the subtree has this tag
        if tag not in absent:
            return True   # every point in the subtree has this tag
        return None       # mixed subtree
    if "not" in expr:
        inner = evaluate_summary(expr["not"], present, absent)
        return None if inner is None else (not inner)
    if "and" in expr:
        saw_unknown = False
        for e in expr["and"]:
            r = evaluate_summary(e, present, absent)
            if r is False:
                return False
            if r is None:
                saw_unknown = True
        return None if saw_unknown else True
    if "or" in expr:
        saw_unknown = False
        for e in expr["or"]:
            r = evaluate_summary(e, present, absent)
            if r is True:
                return True
            if r is None:
                saw_unknown = True
        return None if saw_unknown else False
    raise ValueError(f"invalid filter expression: {expr!r}")
