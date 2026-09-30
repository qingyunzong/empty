"""Boolean tag filters and conservative summary-based pruning.

A filter is a JSON-friendly nested dict:

    None                    matches everything
    {"tag": "a"}            point has tag "a"
    {"and": [f, ...]}       all sub-filters match
    {"or":  [f, ...]}       at least one sub-filter matches
    {"not": f}              sub-filter does not match

Each index node keeps two conservative tag summaries:

* ``tags_any`` -- a *superset* of the union of tags in the subtree
* ``tags_all`` -- a *subset* of the intersection of tags in the subtree

``may_match`` uses them to decide whether some point in the subtree could
satisfy the filter.  It only ever errs towards ``True`` (visit the node),
never towards ``False`` (prune a node that could contain a match), which is
what makes filter pruning safe even when summaries are stale after deletes.
"""

from __future__ import annotations


def validate_filter(filt) -> None:
    if filt is None:
        return
    if not isinstance(filt, dict):
        raise ValueError("filter must be a dict or None")
    keys = [k for k in ("tag", "and", "or", "not") if k in filt]
    if len(keys) != 1 or len(filt) != 1:
        raise ValueError("filter node must have exactly one of: tag, and, or, not")
    if "tag" in filt:
        if not isinstance(filt["tag"], str):
            raise ValueError('"tag" value must be a string')
    elif "not" in filt:
        validate_filter(filt["not"])
    else:
        subs = filt.get("and", filt.get("or"))
        if not isinstance(subs, (list, tuple)) or not subs:
            raise ValueError('"and"/"or" require a non-empty list of filters')
        for sub in subs:
            validate_filter(sub)


def match_tags(filt, tags) -> bool:
    """Exact evaluation of a filter against one point's tag set."""
    if filt is None:
        return True
    if "tag" in filt:
        return filt["tag"] in tags
    if "and" in filt:
        return all(match_tags(sub, tags) for sub in filt["and"])
    if "or" in filt:
        return any(match_tags(sub, tags) for sub in filt["or"])
    return not match_tags(filt["not"], tags)


def may_match(filt, tags_any, tags_all) -> bool:
    """Conservative test: could some point in the subtree satisfy the filter?

    ``False`` is a proof that no point can match; ``True`` means "unknown,
    must descend".  Soundness only requires the summaries to be conservative
    (superset union / subset intersection), so stale summaries stay safe.
    """
    if filt is None:
        return True
    if "tag" in filt:
        return filt["tag"] in tags_any
    if "and" in filt:
        return all(may_match(sub, tags_any, tags_all) for sub in filt["and"])
    if "or" in filt:
        return any(may_match(sub, tags_any, tags_all) for sub in filt["or"])
    return not _must_match(filt["not"], tags_any, tags_all)


def _must_match(filt, tags_any, tags_all) -> bool:
    """Conservative test: is the filter true for *every* subtree point?"""
    if filt is None:
        return True
    if "tag" in filt:
        return filt["tag"] in tags_all
    if "and" in filt:
        return all(_must_match(sub, tags_any, tags_all) for sub in filt["and"])
    if "or" in filt:
        return any(_must_match(sub, tags_any, tags_all) for sub in filt["or"])
    return not may_match(filt["not"], tags_any, tags_all)
