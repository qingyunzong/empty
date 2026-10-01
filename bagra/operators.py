"""Incremental bag-relational-algebra operators.

Every node keeps the minimum state needed to turn an input delta
(row -> signed multiplicity) into an output delta, plus key indexes
where the operator needs them (join).  All operators are linear or
threshold-based, so a batch delta is processed exactly once per node.
"""

from .predicates import compile_predicate


class BagraError(Exception):
    """Raised for invalid graphs, invalid batches or invariant violations."""


def merge_into(state, delta):
    """state += delta, dropping zero entries (negatives kept for validation)."""
    for row, count in delta.items():
        new = state.get(row, 0) + count
        if new:
            state[row] = new
        else:
            state.pop(row, None)


def _copy_value(value):
    if isinstance(value, dict):
        return {k: _copy_value(v) for k, v in value.items()}
    return value


class Node:
    """Base class. `state` is always the node's current output multiset."""

    state_attrs = ("state",)

    def __init__(self, node_id):
        self.id = node_id
        self.parents = []
        self.state = {}

    def snapshot(self):
        return {name: _copy_value(getattr(self, name)) for name in self.state_attrs}

    def restore(self, snap):
        for name, value in snap.items():
            setattr(self, name, _copy_value(value))

    def apply(self, input_deltas):
        """Consume one delta per input, update state, return output delta."""
        raise NotImplementedError


class ScanNode(Node):
    """Source node exposing a base table as a stream of deltas."""

    def __init__(self, node_id, table):
        super().__init__(node_id)
        self.table = table

    def apply(self, input_deltas):
        delta = dict(input_deltas[0])
        merge_into(self.state, delta)
        return delta


class FilterNode(Node):
    def __init__(self, node_id, predicate_spec):
        super().__init__(node_id)
        self.predicate = compile_predicate(predicate_spec)

    def apply(self, input_deltas):
        out = {row: d for row, d in input_deltas[0].items() if self.predicate(row)}
        merge_into(self.state, out)
        return out


class ProjectNode(Node):
    """Bag projection: linear, duplicates merge by summing multiplicities."""

    def __init__(self, node_id, columns):
        super().__init__(node_id)
        self.columns = tuple(columns)

    def apply(self, input_deltas):
        out = {}
        for row, d in input_deltas[0].items():
            key = tuple(row[i] for i in self.columns)
            out[key] = out.get(key, 0) + d
        out = {row: d for row, d in out.items() if d}
        merge_into(self.state, out)
        return out


class UnionAllNode(Node):
    def apply(self, input_deltas):
        out = {}
        for delta in input_deltas:
            merge_into(out, delta)
        merge_into(self.state, out)
        return out


class DistinctNode(Node):
    """Emits +/-1 only when an input row's multiplicity crosses the 0 threshold."""

    state_attrs = ("state", "counts")

    def __init__(self, node_id):
        super().__init__(node_id)
        self.counts = {}

    def apply(self, input_deltas):
        out = {}
        for row, d in input_deltas[0].items():
            old = self.counts.get(row, 0)
            new = old + d
            if new:
                self.counts[row] = new
            else:
                self.counts.pop(row, None)
            if old <= 0 < new:
                out[row] = 1
            elif new <= 0 < old:
                out[row] = -1
        merge_into(self.state, out)
        return out


class JoinNode(Node):
    """Equi-join with key indexes on both sides.

    Batch delta: dL x R_before + L_after x dR, which equals
    dL x R + L x dR + dL x dR (the cross term for simultaneous changes).
    Rows with NULL in any join key never match.
    """

    state_attrs = ("state", "left_counts", "right_counts", "left_index", "right_index")

    def __init__(self, node_id, left_keys, right_keys):
        super().__init__(node_id)
        self.left_keys = tuple(left_keys)
        self.right_keys = tuple(right_keys)
        self.left_counts = {}
        self.right_counts = {}
        self.left_index = {}
        self.right_index = {}

    @staticmethod
    def _key(row, keys):
        key = tuple(row[i] for i in keys)
        if any(v is None for v in key):
            return None
        return key

    def _add(self, counts, index, keys, row, d):
        new = counts.get(row, 0) + d
        if new:
            counts[row] = new
        else:
            counts.pop(row, None)
        key = self._key(row, keys)
        if key is None:
            return
        bucket = index.setdefault(key, {})
        val = bucket.get(row, 0) + d
        if val:
            bucket[row] = val
        else:
            bucket.pop(row, None)
            if not bucket:
                index.pop(key, None)

    def apply(self, input_deltas):
        dl, dr = input_deltas
        out = {}
        for row, d in dl.items():
            key = self._key(row, self.left_keys)
            if key is None:
                continue
            for rrow, rc in self.right_index.get(key, {}).items():
                joined = row + rrow
                out[joined] = out.get(joined, 0) + d * rc
        for row, d in dl.items():
            self._add(self.left_counts, self.left_index, self.left_keys, row, d)
        for row, d in dr.items():
            key = self._key(row, self.right_keys)
            if key is None:
                continue
            for lrow, lc in self.left_index.get(key, {}).items():
                joined = lrow + row
                out[joined] = out.get(joined, 0) + lc * d
        for row, d in dr.items():
            self._add(self.right_counts, self.right_index, self.right_keys, row, d)
        out = {row: d for row, d in out.items() if d}
        merge_into(self.state, out)
        return out


class _BinarySetNode(Node):
    """Shared machinery for intersect_all / except_all.

    Keeps both input multisets; per affected row the output moves from
    combine(l_old, r_old) to combine(l_new, r_new), which handles
    0-threshold crossings exactly.
    """

    state_attrs = ("state", "left_counts", "right_counts")

    def __init__(self, node_id):
        super().__init__(node_id)
        self.left_counts = {}
        self.right_counts = {}

    @staticmethod
    def combine(left, right):
        raise NotImplementedError

    def apply(self, input_deltas):
        dl, dr = input_deltas
        merge_into(self.left_counts, dl)
        merge_into(self.right_counts, dr)
        out = {}
        for row in set(dl) | set(dr):
            new = self.combine(self.left_counts.get(row, 0), self.right_counts.get(row, 0))
            old = self.state.get(row, 0)
            if new != old:
                out[row] = new - old
                if new:
                    self.state[row] = new
                else:
                    self.state.pop(row, None)
        return out


class IntersectAllNode(_BinarySetNode):
    @staticmethod
    def combine(left, right):
        return min(left, right)


class ExceptAllNode(_BinarySetNode):
    """except_all = max(left - right, 0); never fails on negative differences."""

    @staticmethod
    def combine(left, right):
        return max(left - right, 0)


def build_node(spec):
    kind = spec["type"]
    node_id = spec["id"]
    if kind == "scan":
        return ScanNode(node_id, spec["table"])
    if kind == "filter":
        return FilterNode(node_id, spec.get("predicate"))
    if kind == "project":
        return ProjectNode(node_id, spec["columns"])
    if kind == "join":
        return JoinNode(node_id, spec["left_keys"], spec["right_keys"])
    if kind == "union_all":
        return UnionAllNode(node_id)
    if kind == "intersect_all":
        return IntersectAllNode(node_id)
    if kind == "except_all":
        return ExceptAllNode(node_id)
    if kind == "distinct":
        return DistinctNode(node_id)
    raise BagraError(f"unknown node type: {kind!r}")
