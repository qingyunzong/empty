"""Compressed dictionary automaton: a minimal acyclic DFA (DAFSA).

Built from the sorted term set; equivalent suffixes (and therefore shared
prefixes) are merged into single nodes, so the structure is a compressed
automaton rather than a plain trie.  The automaton is rebuilt from the
current term set whenever terms are added or their last reference is
removed, which is how node splits/merges stay in sync with the index.
"""

from __future__ import annotations


class Node:
    __slots__ = ("children", "terminal", "id")

    def __init__(self):
        self.children = {}  # code point (str of len 1) -> Node
        self.terminal = False
        self.id = -1


class Automaton:
    """Minimal acyclic deterministic automaton over a set of words."""

    def __init__(self, words):
        start = Node()
        for word in sorted(set(words)):
            node = start
            for ch in word:
                nxt = node.children.get(ch)
                if nxt is None:
                    nxt = Node()
                    node.children[ch] = nxt
                node = nxt
            node.terminal = True
        self.start = self._minimize(start, {})
        self.nodes = []
        self._assign_ids()

    @staticmethod
    def _minimize(node, registry):
        items = []
        for ch in sorted(node.children):
            child = Automaton._minimize(node.children[ch], registry)
            items.append((ch, child))
        key = (node.terminal, tuple((ch, id(child)) for ch, child in items))
        canonical = registry.get(key)
        if canonical is not None:
            return canonical
        node.children = dict(items)
        registry[key] = node
        return node

    def _assign_ids(self):
        seen = {id(self.start): self.start}
        queue = [self.start]
        self.start.id = 0
        self.nodes = [self.start]
        while queue:
            node = queue.pop(0)
            for ch in sorted(node.children):
                child = node.children[ch]
                if id(child) not in seen:
                    seen[id(child)] = child
                    child.id = len(self.nodes)
                    self.nodes.append(child)
                    queue.append(child)

    @property
    def node_count(self):
        return len(self.nodes)

    def walk(self, prefix):
        """Return the node reached by following `prefix`, or None."""
        node = self.start
        for ch in prefix:
            node = node.children.get(ch)
            if node is None:
                return None
        return node

    def accepts(self, word):
        node = self.walk(word)
        return node is not None and node.terminal

    def sorted_edges(self, node):
        return sorted(node.children.items())
