"""xmerge: recursive three-way merge over a commit graph.

Graph model: a dict mapping node id -> {"parents": [id, ...], "tree": {path: str}}.
Merge bases are the lowest common ancestors: common ancestors of the two heads
for which no *other* common ancestor is a descendant of them.  Multiple merge
bases are merged pairwise in ascending id order, producing virtual base nodes
(git-style recursive merge).  Paths that conflict while constructing a virtual
base stay conflicts in the final merge and are never auto-resolved.
"""

import json

__all__ = [
    "GraphError",
    "load_graph",
    "validate_graph",
    "ancestors",
    "merge_bases",
    "merge_trees",
    "merge_heads",
]


class GraphError(Exception):
    """Raised for invalid input: duplicates, cycles, unknown nodes, bad shape."""


def _no_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise GraphError(f"duplicate key: {key!r}")
        obj[key] = value
    return obj


def load_graph(path):
    """Load and validate a graph JSON file. Raises GraphError on any problem."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle, object_pairs_hook=_no_duplicate_keys)
    except GraphError:
        raise
    except (OSError, json.JSONDecodeError) as exc:
        raise GraphError(f"cannot read graph file: {exc}") from exc
    if not isinstance(data, dict):
        raise GraphError("top-level JSON value must be an object mapping ids to nodes")
    validate_graph(data)
    return data


def validate_graph(graph):
    """Validate structure, parent references and acyclicity."""
    for node_id, node in graph.items():
        if not isinstance(node, dict):
            raise GraphError(f"node {node_id!r}: must be an object")
        parents = node.get("parents")
        tree = node.get("tree")
        if not isinstance(parents, list) or not all(isinstance(p, str) for p in parents):
            raise GraphError(f"node {node_id!r}: 'parents' must be a list of strings")
        if not isinstance(tree, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in tree.items()
        ):
            raise GraphError(f"node {node_id!r}: 'tree' must map string paths to strings")
        for parent in parents:
            if parent not in graph:
                raise GraphError(f"node {node_id!r}: unknown parent {parent!r}")
    _check_acyclic(graph)


def _check_acyclic(graph):
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {node_id: WHITE for node_id in graph}
    for start in graph:
        if color[start] != WHITE:
            continue
        color[start] = GRAY
        stack = [(start, iter(graph[start]["parents"]))]
        while stack:
            node_id, parents_iter = stack[-1]
            descended = False
            for parent in parents_iter:
                if color[parent] == GRAY:
                    raise GraphError(f"cycle detected involving node {parent!r}")
                if color[parent] == WHITE:
                    color[parent] = GRAY
                    stack.append((parent, iter(graph[parent]["parents"])))
                    descended = True
                    break
            if not descended:
                color[node_id] = BLACK
                stack.pop()


def ancestors(graph, node_id):
    """Set of node_id and all its transitive ancestors (independent enumeration)."""
    seen = set()
    stack = [node_id]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        stack.extend(graph[current]["parents"])
    return seen


def merge_bases(graph, head_a, head_b):
    """Lowest common ancestors of head_a and head_b, sorted by id.

    A common ancestor c is a merge base iff no other common ancestor has c
    among its own ancestors (i.e. c has no common-ancestor descendant).
    """
    cache = {}

    def anc(node_id):
        if node_id not in cache:
            cache[node_id] = ancestors(graph, node_id)
        return cache[node_id]

    common = anc(head_a) & anc(head_b)
    return sorted(
        candidate
        for candidate in common
        if not any(
            candidate != other and candidate in anc(other) for other in common
        )
    )


def merge_trees(base, ours, theirs):
    """Three-way per-path merge. Missing paths count as null (deleted).

    Returns (merged_tree, conflicts). Conflicted paths are excluded from the
    merged tree.
    """
    merged = {}
    conflicts = set()
    for path in sorted(set(base) | set(ours) | set(theirs)):
        base_val = base.get(path)
        our_val = ours.get(path)
        their_val = theirs.get(path)
        if our_val == their_val:
            if our_val is not None:
                merged[path] = our_val
        elif base_val == our_val:
            if their_val is not None:
                merged[path] = their_val
        elif base_val == their_val:
            if our_val is not None:
                merged[path] = our_val
        else:
            conflicts.add(path)
    return merged, conflicts


def merge_heads(graph, head_a, head_b):
    """Merge two heads. Returns (merged_tree, sorted_conflict_paths)."""
    for head in (head_a, head_b):
        if head not in graph:
            raise GraphError(f"unknown head: {head!r}")
    work = {
        node_id: {"parents": list(node["parents"]), "tree": dict(node["tree"])}
        for node_id, node in graph.items()
    }
    counter = [0]
    merged, conflicts = _merge_commits(work, head_a, head_b, counter)
    return merged, sorted(conflicts)


def _merge_commits(graph, id_a, id_b, counter):
    """Merge two commits (real or virtual). Returns (tree, conflict_path_set)."""
    bases = merge_bases(graph, id_a, id_b)
    inherited_conflicts = set()
    if not bases:
        base_tree = {}
    elif len(bases) == 1:
        base_tree = dict(graph[bases[0]]["tree"])
    else:
        base_tree, inherited_conflicts = _build_virtual_base(graph, bases, counter)
    merged, conflicts = merge_trees(base_tree, graph[id_a]["tree"], graph[id_b]["tree"])
    # Rule: paths that conflicted while constructing the virtual base are
    # conflicts in the final merge too; never auto-resolve them.
    for path in inherited_conflicts:
        conflicts.add(path)
        merged.pop(path, None)
    return merged, conflicts


def _build_virtual_base(graph, bases, counter):
    """Merge multiple merge bases pairwise in ascending id order.

    Returns (virtual_tree, conflict_path_set).
    """
    ordered = sorted(bases)
    acc_tree, acc_conflicts = _merge_commits(graph, ordered[0], ordered[1], counter)
    acc_id = _add_virtual_node(graph, ordered[0], ordered[1], acc_tree, counter)
    for next_base in ordered[2:]:
        acc_tree, new_conflicts = _merge_commits(graph, acc_id, next_base, counter)
        acc_conflicts |= new_conflicts
        acc_id = _add_virtual_node(graph, acc_id, next_base, acc_tree, counter)
    return acc_tree, acc_conflicts


def _add_virtual_node(graph, parent_a, parent_b, tree, counter):
    counter[0] += 1
    virtual_id = f"__virtual_{counter[0]}__"
    graph[virtual_id] = {"parents": [parent_a, parent_b], "tree": dict(tree)}
    return virtual_id
