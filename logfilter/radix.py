"""Compressed dictionary automaton (radix / Patricia tree over code points).

Edges carry string labels; shared prefixes are stored once.  Insertion may
split an edge, deletion may merge an edge with its single child.  The tree
is traversed char-by-char through opaque *positions* so the pattern
automaton can be intersected with the dictionary on demand, without ever
expanding the stored words.

A position is a tuple ``(node, key, offset)``:

* ``key is None``     -- exactly at ``node``
* otherwise           -- ``offset`` chars into the label of the edge
                         ``node.children[key]``

Any consumed prefix string identifies at most one position, so frontier
positions can be serialized as plain strings for pause/resume.
"""

from __future__ import annotations


class _Node:
    __slots__ = ("children", "is_term")

    def __init__(self):
        self.children = {}  # first char -> _Edge
        self.is_term = False


class _Edge:
    __slots__ = ("label", "node")

    def __init__(self, label, node):
        self.label = label
        self.node = node


class RadixTree:
    def __init__(self):
        self.root = _Node()
        self.size = 0

    # -- mutation ---------------------------------------------------------

    def add(self, word: str) -> bool:
        """Insert word.  Returns True if it was not already present."""
        node = self.root
        i = 0
        while i < len(word):
            key = word[i]
            edge = node.children.get(key)
            if edge is None:
                leaf = _Node()
                leaf.is_term = True
                node.children[key] = _Edge(word[i:], leaf)
                self.size += 1
                return True
            label = edge.label
            j = 0
            while j < len(label) and i + j < len(word) and label[j] == word[i + j]:
                j += 1
            if j == len(label):
                node = edge.node
                i += j
                continue
            # split the edge at j
            mid = _Node()
            rest = _Edge(label[j:], edge.node)
            mid.children[label[j]] = rest
            edge.label = label[:j]
            edge.node = mid
            if i + j == len(word):
                mid.is_term = True
            else:
                leaf = _Node()
                leaf.is_term = True
                mid.children[word[i + j]] = _Edge(word[i + j:], leaf)
            self.size += 1
            return True
        if node.is_term:
            return False
        node.is_term = True
        self.size += 1
        return True

    def remove(self, word: str) -> bool:
        """Remove word, merging compressed nodes as needed.
        Returns True if the word was present."""
        stack = []  # (parent_node, key)
        node = self.root
        i = 0
        while i < len(word):
            edge = node.children.get(word[i])
            if edge is None or not word.startswith(edge.label, i):
                return False
            stack.append((node, word[i]))
            node = edge.node
            i += len(edge.label)
        if not node.is_term:
            return False
        node.is_term = False
        self.size -= 1
        # prune / merge upward
        while stack:
            if node.is_term or len(node.children) > 1:
                break
            parent, key = stack[-1]
            edge = parent.children[key]
            if len(node.children) == 1:
                # merge the single child edge into the incoming edge
                (child_edge,) = node.children.values()
                edge.label += child_edge.label
                edge.node = child_edge.node
                break  # child counts above are unchanged
            # leaf without a term: drop the edge and continue upward
            del parent.children[key]
            stack.pop()
            node = parent
        return True

    # -- queries ----------------------------------------------------------

    def contains(self, word: str) -> bool:
        node = self.root
        i = 0
        while i < len(word):
            edge = node.children.get(word[i])
            if edge is None or not word.startswith(edge.label, i):
                return False
            node = edge.node
            i += len(edge.label)
        return node.is_term

    def words(self):
        """Yield all stored words in lexicographic order."""
        stack = [(self.root, "")]
        while stack:
            node, prefix = stack.pop()
            if node.is_term:
                yield prefix
            for key in sorted(node.children, reverse=True):
                edge = node.children[key]
                stack.append((edge.node, prefix + edge.label))

    # -- traversal positions ----------------------------------------------

    def initial_position(self):
        return (self.root, None, 0)

    @staticmethod
    def position_node(pos):
        """Return the node if the position sits exactly on one, else None."""
        node, key, offset = pos
        return node if key is None else None

    def advance(self, pos):
        """Yield (char, next_position) for every code point leaving pos."""
        node, key, offset = pos
        if key is None:
            for child_key, edge in node.children.items():
                if len(edge.label) == 1:
                    yield edge.label[0], (edge.node, None, 0)
                else:
                    yield edge.label[0], (node, child_key, 1)
        else:
            edge = node.children[key]
            ch = edge.label[offset]
            if offset + 1 == len(edge.label):
                yield ch, (edge.node, None, 0)
            else:
                yield ch, (node, key, offset + 1)

    def locate(self, prefix: str):
        """Resolve a consumed prefix string back to a position.

        Raises KeyError if the prefix does not lie on any root-to-node path.
        """
        node = self.root
        i = 0
        while i < len(prefix):
            key = prefix[i]
            edge = node.children.get(key)
            if edge is None:
                raise KeyError(prefix)
            label = edge.label
            if prefix.startswith(label, i):
                i += len(label)
                node = edge.node
            elif label.startswith(prefix[i:]):
                return (node, key, len(prefix) - i)
            else:
                raise KeyError(prefix)
        return (node, None, 0)
