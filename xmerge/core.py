"""Recursive three-way merge over a commit DAG.

Graph model: each node id maps to {"parents": [id, ...], "tree": {path: str}}.
Merge bases are the lowest common ancestors: common ancestors that have no
other common ancestor as a descendant.  Multiple merge bases are merged
pairwise (in ascending id order) into a virtual base, recursively.
"""

from __future__ import annotations


class GraphError(Exception):
    """Raised for malformed graphs (unknown heads, cycles, duplicates)."""


def _check_node(nid, node):
    if not isinstance(node, dict):
        raise GraphError(f"node {nid!r}: entry must be an object")
    parents = node.get("parents")
    tree = node.get("tree")
    if not isinstance(parents, list) or not all(isinstance(p, str) for p in parents):
        raise GraphError(f"node {nid!r}: 'parents' must be a list of node ids")
    if not isinstance(tree, dict) or not all(isinstance(k, str) for k in tree):
        raise GraphError(f"node {nid!r}: 'tree' must be an object mapping paths to values")


class Graph:
    def __init__(self, nodes):
        if not isinstance(nodes, dict):
            raise GraphError("graph must be an object mapping node ids to nodes")
        self.nodes = nodes
        for nid, node in nodes.items():
            _check_node(nid, node)
        for nid, node in nodes.items():
            for parent in node["parents"]:
                if parent not in nodes:
                    raise GraphError(f"node {nid!r}: unknown parent {parent!r}")
        self._check_acyclic()

    def _check_acyclic(self):
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {nid: WHITE for nid in self.nodes}
        for start in self.nodes:
            if color[start] != WHITE:
                continue
            color[start] = GRAY
            stack = [(start, iter(self.nodes[start]["parents"]))]
            while stack:
                nid, it = stack[-1]
                descended = False
                for parent in it:
                    if color[parent] == GRAY:
                        raise GraphError(f"cycle detected involving node {parent!r}")
                    if color[parent] == WHITE:
                        color[parent] = GRAY
                        stack.append((parent, iter(self.nodes[parent]["parents"])))
                        descended = True
                        break
                if not descended:
                    color[nid] = BLACK
                    stack.pop()

    def ancestors(self, nid):
        """Set of nid and all nodes reachable from it via parent edges."""
        seen = set()
        stack = [nid]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(self.nodes[cur]["parents"])
        return seen

    def merge_bases(self, a, b):
        """Lowest common ancestors of a and b, sorted by id.

        A common ancestor c is a merge base iff no other common ancestor
        has c as a (proper) ancestor, i.e. c has no common-ancestor
        descendant.
        """
        common = self.ancestors(a) & self.ancestors(b)
        bases = [
            c
            for c in common
            if not any(c != other and c in self.ancestors(other) for other in common)
        ]
        return sorted(bases)


def three_way_merge(base, ours, theirs):
    """Per-path three-way merge. Missing path == None.

    Returns (tree, conflict_paths).  Conflicted paths are omitted from the
    result tree.
    """
    tree = {}
    conflicts = set()
    for path in base.keys() | ours.keys() | theirs.keys():
        b = base.get(path)
        o = ours.get(path)
        t = theirs.get(path)
        if o == t:  # both unchanged, both changed identically, or both deleted
            if o is not None:
                tree[path] = o
        elif b == o:  # only theirs changed (possibly a deletion)
            if t is not None:
                tree[path] = t
        elif b == t:  # only ours changed (possibly a deletion)
            if o is not None:
                tree[path] = o
        else:  # both changed differently, or modify/delete
            conflicts.add(path)
    return tree, conflicts


class Merger:
    def __init__(self, graph):
        self.graph = graph
        self._virtual_counter = 0

    def merge_commits(self, a, b):
        """Recursively merge commits a and b.

        Returns (tree, conflict_paths).  Paths that conflicted while
        constructing a virtual base are reported as conflicts here too and
        are never auto-resolved.
        """
        bases = self.graph.merge_bases(a, b)
        if not bases:
            base_tree, poisoned = {}, set()
        elif len(bases) == 1:
            base_tree = dict(self.graph.nodes[bases[0]]["tree"])
            poisoned = set()
        else:
            base_tree, poisoned = self._build_virtual_base(bases)
        tree, conflicts = three_way_merge(
            base_tree,
            self.graph.nodes[a]["tree"],
            self.graph.nodes[b]["tree"],
        )
        conflicts |= poisoned
        for path in poisoned:
            tree.pop(path, None)
        return tree, conflicts

    def _build_virtual_base(self, bases):
        """Merge multiple merge bases pairwise (ascending id order)."""
        cur = bases[0]
        poisoned = set()
        for nxt in bases[1:]:
            tree, sub_conflicts = self.merge_commits(cur, nxt)
            poisoned |= sub_conflicts
            vid = self._fresh_virtual_id()
            self.graph.nodes[vid] = {"parents": [cur, nxt], "tree": tree}
            cur = vid
        return dict(self.graph.nodes[cur]["tree"]), poisoned

    def _fresh_virtual_id(self):
        while True:
            vid = f"<virtual-{self._virtual_counter}>"
            self._virtual_counter += 1
            if vid not in self.graph.nodes:
                return vid
