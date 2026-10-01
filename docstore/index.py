"""Path indexes.

An index is defined by a pattern of path segments (object keys, array
indices, or the ``*`` wildcard, possibly nested such as ``/a/*/b/*``).
It maps every scalar value found at a matching path to the set of
concrete paths where it occurs.

Indexes are immutable once published: a batch commit builds the next
generation by copying and applying only the incremental delta reported
by the patch engine, so old snapshots keep a consistent view.
"""

from .paths import pattern_matches, to_pointer
from .values import is_scalar, value_key


def _node_at(doc, typed_prefix):
    node = doc
    for seg in typed_prefix:
        node = node[seg]
    return node


class Index:
    __slots__ = ("name", "pattern", "pattern_text", "entries", "locations")

    def __init__(self, name, pattern, pattern_text):
        self.name = name
        self.pattern = pattern
        self.pattern_text = pattern_text
        self.entries = {}     # value_key -> set of typed paths
        self.locations = {}   # typed path -> scalar value

    @classmethod
    def build(cls, name, pattern, pattern_text, doc):
        """Full build by document traversal (used at open / create time)."""
        idx = cls(name, pattern, pattern_text)
        idx.add_subtree(doc, ())
        return idx

    def copy(self):
        idx = Index(self.name, self.pattern, self.pattern_text)
        idx.entries = {k: set(v) for k, v in self.entries.items()}
        idx.locations = dict(self.locations)
        return idx

    # -- incremental maintenance -------------------------------------

    def add_subtree(self, doc, typed_prefix):
        """Scan the subtree at ``typed_prefix`` and record matches."""
        stack = [(_node_at(doc, typed_prefix), tuple(typed_prefix))]
        while stack:
            node, path = stack.pop()
            if pattern_matches(self.pattern, path) and is_scalar(node):
                self._record(path, node)
            if isinstance(node, dict):
                for key, val in node.items():
                    stack.append((val, path + (key,)))
            elif isinstance(node, list):
                for pos, val in enumerate(node):
                    stack.append((val, path + (pos,)))

    def remove_under(self, typed_prefix):
        """Drop every entry at or below ``typed_prefix``."""
        prefix = tuple(typed_prefix)
        plen = len(prefix)
        doomed = [p for p in self.locations if p[:plen] == prefix]
        for path in doomed:
            value = self.locations.pop(path)
            key = value_key(value)
            bucket = self.entries.get(key)
            if bucket is not None:
                bucket.discard(path)
                if not bucket:
                    del self.entries[key]
        return doomed

    def _record(self, path, value):
        self.entries.setdefault(value_key(value), set()).add(path)
        self.locations[path] = value

    # -- introspection ------------------------------------------------

    def entry_count(self):
        return len(self.locations)

    def as_map(self):
        """Pointer-string -> value view, handy for tests and the CLI."""
        return {to_pointer(p): v for p, v in self.locations.items()}
