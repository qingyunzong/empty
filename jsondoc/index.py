"""Path-pattern indexes with wildcard support and incremental updates.

An index pattern is a JSON pointer where a segment may be ``*`` to
match any object key or array index, e.g. ``/items/*/price`` or
``/*/*/v`` (nested wildcards). Only scalar leaves are indexed.

Indexes are immutable: :meth:`Index.updated` returns a new Index that
structurally shares every untouched entry with its predecessor, so old
versions keep working and updates stay incremental (only the affected
subtrees of the affected document are re-extracted).
"""
from __future__ import annotations

from . import pointers
from .strictjson import type_name, value_key

__all__ = ["Index", "extract", "extract_pairs", "navigate"]

_MISSING = object()


def navigate(doc, segments):
    """Return the node at ``segments`` or the ``_MISSING`` sentinel."""
    node = doc
    for seg in segments:
        if isinstance(node, dict):
            if seg not in node:
                return _MISSING
            node = node[seg]
        elif isinstance(node, list):
            if not seg.isdigit() or int(seg) >= len(node):
                return _MISSING
            node = node[int(seg)]
        else:
            return _MISSING
    return node


def extract(node, pattern, path, out):
    """Collect ``(formatted_path, value_key)`` pairs matching ``pattern``."""
    if not pattern:
        if type_name(node) not in ("array", "object"):
            out.append((pointers.format(path), value_key(node)))
        return
    seg, rest = pattern[0], pattern[1:]
    if seg == "*":
        if isinstance(node, dict):
            for key, child in node.items():
                extract(child, rest, path + [key], out)
        elif isinstance(node, list):
            for i, child in enumerate(node):
                extract(child, rest, path + [str(i)], out)
    elif isinstance(node, dict):
        if seg in node:
            extract(node[seg], rest, path + [seg], out)
    elif isinstance(node, list):
        if seg.isdigit() and int(seg) < len(node):
            extract(node[int(seg)], rest, path + [seg], out)


def _pattern_suffix(pattern, segments):
    """Pattern remainder applicable at ``segments`` depth, or None.

    Returns None when the root is outside the pattern's scope (a
    literal mismatch) or deeper than the pattern (matches would live
    above the root, so nothing below can belong to this index).
    """
    if len(segments) > len(pattern):
        return None
    for pat_seg, seg in zip(pattern, segments):
        if pat_seg != "*" and pat_seg != seg:
            return None
    return pattern[len(segments):]


def extract_pairs(doc, pattern, roots):
    """Extract pairs for ``pattern`` limited to the given subtree roots."""
    out = []
    for root in roots:
        segments = pointers.parse(root)
        suffix = _pattern_suffix(pattern, segments)
        if suffix is None:
            continue
        node = navigate(doc, segments)
        if node is _MISSING:
            continue
        extract(node, suffix, segments, out)
    return out


class Index:
    """Immutable mapping from scalar values to document paths."""

    __slots__ = ("name", "pattern", "entries", "by_doc")

    def __init__(self, name, pattern, entries=None, by_doc=None):
        self.name = name
        self.pattern = tuple(pattern)
        # value_key -> frozenset((doc_id, path))
        self.entries = entries if entries is not None else {}
        # doc_id -> frozenset((path, value_key))
        self.by_doc = by_doc if by_doc is not None else {}

    @classmethod
    def build(cls, name, pattern, docs, on_scan=None):
        """Full-traversal build over a ``{doc_id: document}`` mapping."""
        entries = {}
        by_doc = {}
        for doc_id, doc in docs.items():
            if on_scan is not None:
                on_scan(doc_id)
            pairs = []
            extract(doc, tuple(pattern), [], pairs)
            pair_set = frozenset(pairs)
            if pair_set:
                by_doc[doc_id] = pair_set
                for path, vk in pair_set:
                    bucket = entries.setdefault(vk, set())
                    bucket.add((doc_id, path))
        return cls(
            name,
            pattern,
            {vk: frozenset(pairs) for vk, pairs in entries.items()},
            by_doc,
        )

    def updated(self, doc_id, removed_roots, added_pairs):
        """Return a new Index with one document's subtrees refreshed.

        Entries outside ``removed_roots`` (and all entries of other
        documents) are shared with the returned index, not rebuilt.
        """
        old_pairs = self.by_doc.get(doc_id, frozenset())
        kept = frozenset(
            pair
            for pair in old_pairs
            if not any(pointers.is_prefix(root, pair[0]) for root in removed_roots)
        )
        removed = old_pairs - kept
        new_pairs = kept | frozenset(added_pairs)
        by_doc = dict(self.by_doc)
        if new_pairs:
            by_doc[doc_id] = new_pairs
        else:
            by_doc.pop(doc_id, None)
        entries = dict(self.entries)
        for path, vk in removed:
            remaining = entries[vk] - {(doc_id, path)}
            if remaining:
                entries[vk] = remaining
            else:
                del entries[vk]
        for path, vk in added_pairs:
            entries[vk] = entries.get(vk, frozenset()) | {(doc_id, path)}
        return Index(self.name, self.pattern, entries, by_doc)

    def entry_count(self):
        return sum(len(pairs) for pairs in self.entries.values())
