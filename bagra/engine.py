"""Incremental bag relational algebra engine.

Compiles subscription plans into a shared DAG of operator nodes.  Each
committed batch of signed-multiplicity changes is pushed through the DAG
exactly once per node; only the resulting deltas (insertions and
deletions of result tuples) are published to subscribers.

Transactional guarantees:

* a batch is validated in full before any state is mutated, so any error
  (e.g. a negative committed multiplicity) rolls the whole graph back
  with no publishes and no version bump;
* committed base tables and all committed node multiplicities are always
  non-negative;
* batches may carry a caller-supplied batch id; re-applying an already
  committed batch id is a no-op, so replay after recovery never
  republishes.
"""
from __future__ import annotations

import json
from collections import defaultdict

from .interpreter import evaluate, join_key
from .plans import Plan, plan_from_json


class BagraError(Exception):
    """Base class for engine errors."""


class NegativeMultiplicityError(BagraError):
    """A committed base table or node multiplicity would go negative."""


class UnknownSubscriptionError(BagraError):
    pass


class DuplicateSubscriptionError(BagraError):
    pass


def row_sort_key(row: tuple) -> str:
    """Deterministic, total order over result rows for publishing."""
    return json.dumps(list(row))


def _freeze(value):
    """Recursively convert lists to tuples so JSON-round-tripped batch
    ids remain hashable and compare equal to their originals."""
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(v) for v in value)
    return value


def _clean(delta: dict) -> dict:
    return {row: mult for row, mult in delta.items() if mult != 0}


class Node:
    """A compiled operator.  Only the minimal state required by the
    operator is kept:

    * scan:        none (the committed base table is the state)
    * filter/project/union_all: none (stateless)
    * join:        key indexes over both committed inputs
    * intersect_all/except_all: committed multiplicities of both inputs
    * distinct:    committed multiplicities of its input
    """

    __slots__ = ("plan", "inputs", "lidx", "ridx", "cl", "cr", "counts",
                 "compute_count")

    def __init__(self, plan: Plan, inputs: tuple):
        self.plan = plan
        self.inputs = inputs
        self.lidx = None
        self.ridx = None
        self.cl = None
        self.cr = None
        self.counts = None
        self.compute_count = 0  # instrumentation: batches that touched this node


# --- per-operator delta computation (pure: reads committed state) --------

def _compute_delta(node: Node, din: list) -> dict:
    node.compute_count += 1
    op = node.plan.op
    if op == "filter":
        pred = node.plan.pred
        return _clean({r: m for r, m in din[0].items() if pred.test(r)})

    if op == "project":
        cols = node.plan.cols
        out = defaultdict(int)
        for row, mult in din[0].items():
            out[tuple(row[i] for i in cols)] += mult
        return _clean(out)

    if op == "union_all":
        out = defaultdict(int)
        for src in din:
            for row, mult in src.items():
                out[row] += mult
        return _clean(out)

    if op == "join":
        return _join_delta(node, din[0], din[1])

    if op == "intersect_all":
        return _threshold_delta(node, din[0], din[1], min)

    if op == "except_all":
        return _threshold_delta(
            node, din[0], din[1], lambda l, r: max(l - r, 0))

    if op == "distinct":
        out = {}
        counts = node.counts
        for row, mult in din[0].items():
            old = counts.get(row, 0)
            new = old + mult
            if old == 0 and new > 0:
                out[row] = 1
            elif old > 0 and new == 0:
                out[row] = -1
        return out

    raise ValueError(f"cannot compute delta for {op!r}")  # pragma: no cover


def _join_delta(node: Node, dl: dict, dr: dict) -> dict:
    """(L+dL) x (R+dR) - L x R  =  dL x R  +  L x dR  +  dL x dR.

    The dL x dR cross term handles both sides changing in one batch.
    """
    plan = node.plan
    out = defaultdict(int)
    dr_idx = defaultdict(list)
    for row, mult in dr.items():
        key = join_key(row, plan.right_cols)
        if key is not None:
            dr_idx[key].append((row, mult))
    for row, mult in dl.items():
        key = join_key(row, plan.cols)
        if key is None:
            continue
        for rrow, rmult in node.ridx.get(key, {}).items():
            out[row + rrow] += mult * rmult
        for rrow, rmult in dr_idx.get(key, ()):
            out[row + rrow] += mult * rmult
    for key, lrows in node.lidx.items():
        if key not in dr_idx:
            continue
        for lrow, lmult in lrows.items():
            for rrow, rmult in dr_idx[key]:
                out[lrow + rrow] += lmult * rmult
    return _clean(out)


def _threshold_delta(node: Node, dl: dict, dr: dict, fn) -> dict:
    """Delta for min / max(l-r,0) style operators.

    Only keys whose left or right multiplicity changed can change the
    output; for those we diff the old and new thresholded values, which
    emits exactly on crossings of the zero threshold.
    """
    out = {}
    cl, cr = node.cl, node.cr
    for row in set(dl) | set(dr):
        old = fn(cl.get(row, 0), cr.get(row, 0))
        new = fn(cl.get(row, 0) + dl.get(row, 0),
                 cr.get(row, 0) + dr.get(row, 0))
        if new != old:
            out[row] = new - old
    return out


# --- validation of prospective committed state ----------------------------

def _validate(node: Node, din: list) -> None:
    op = node.plan.op
    if op == "join":
        _check_index(node.lidx, din[0], node.plan.cols, op)
        _check_index(node.ridx, din[1], node.plan.right_cols, op)
    elif op in ("intersect_all", "except_all"):
        _check_counts(node.cl, din[0], op)
        _check_counts(node.cr, din[1], op)
    elif op == "distinct":
        _check_counts(node.counts, din[0], op)


def _check_counts(counts: dict, delta: dict, op: str) -> None:
    for row, mult in delta.items():
        if counts.get(row, 0) + mult < 0:
            raise NegativeMultiplicityError(
                f"{op} input row {list(row)!r} would have negative "
                f"multiplicity")


def _check_index(idx: dict, delta: dict, cols: tuple, op: str) -> None:
    for row, mult in delta.items():
        key = join_key(row, cols)
        if key is None:
            continue
        if idx.get(key, {}).get(row, 0) + mult < 0:
            raise NegativeMultiplicityError(
                f"{op} input row {list(row)!r} would have negative "
                f"multiplicity")


# --- committed-state maintenance ------------------------------------------

def _index_add(idx: dict, delta: dict, cols: tuple) -> None:
    for row, mult in delta.items():
        key = join_key(row, cols)
        if key is None:
            continue
        bucket = idx.setdefault(key, {})
        bucket[row] = bucket.get(row, 0) + mult
        if bucket[row] == 0:
            del bucket[row]
        if not bucket:
            del idx[key]


def _counts_add(counts: dict, delta: dict) -> None:
    for row, mult in delta.items():
        new = counts.get(row, 0) + mult
        if new == 0:
            counts.pop(row, None)
        else:
            counts[row] = new


def _apply(node: Node, din: list) -> None:
    op = node.plan.op
    if op == "join":
        _index_add(node.lidx, din[0], node.plan.cols)
        _index_add(node.ridx, din[1], node.plan.right_cols)
    elif op in ("intersect_all", "except_all"):
        _counts_add(node.cl, din[0])
        _counts_add(node.cr, din[1])
    elif op == "distinct":
        _counts_add(node.counts, din[0])


def _init_node(node: Node, tables: dict) -> None:
    """Bulk-initialize a fresh node's state from committed base data."""
    plan = node.plan
    if plan.op == "join":
        node.lidx = {}
        node.ridx = {}
        _index_add(node.lidx, evaluate(plan.inputs[0], tables), plan.cols)
        _index_add(node.ridx, evaluate(plan.inputs[1], tables),
                   plan.right_cols)
    elif plan.op in ("intersect_all", "except_all"):
        node.cl = evaluate(plan.inputs[0], tables)
        node.cr = evaluate(plan.inputs[1], tables)
    elif plan.op == "distinct":
        node.counts = evaluate(plan.inputs[0], tables)


class Engine:
    """Hosts base tables, compiled subscriptions, and the publish log."""

    def __init__(self):
        self.tables = {}                 # table name -> {row: mult}
        self.version = 0
        self.committed_batches = set()   # batch ids, for replay dedup
        self.subscriptions = {}          # sid -> root Node
        self.publish_log = []            # all published records, in order
        self._node_by_plan = {}          # hash-consing: Plan -> Node
        self._topo = []                  # reachable nodes, dependencies first

    # -- subscription management ------------------------------------------

    def add_subscription(self, sid: str, plan: Plan,
                         publish_initial: bool = True) -> list:
        """Compile (sharing existing nodes) and subscribe.

        Publishes the current full result as insertion records tagged
        with the current version, so a subscriber starts from a complete
        snapshot and thereafter receives only deltas.
        """
        if sid in self.subscriptions:
            raise DuplicateSubscriptionError(sid)
        root = self._compile(plan)
        self.subscriptions[sid] = root
        self._refresh_topo()
        records = []
        if publish_initial:
            snapshot = evaluate(plan, self.tables)
            for seq, row in enumerate(sorted(snapshot, key=row_sort_key)):
                mult = snapshot[row]
                if mult <= 0:
                    continue
                rec = {"version": self.version, "subscription": sid,
                       "seq": seq, "row": list(row), "delta": mult}
                records.append(rec)
                self.publish_log.append(rec)
        return records

    def remove_subscription(self, sid: str) -> None:
        if sid not in self.subscriptions:
            raise UnknownSubscriptionError(sid)
        del self.subscriptions[sid]
        self._refresh_topo()
        # garbage-collect nodes no longer reachable from any output
        reachable = set(self._topo)
        for plan, node in list(self._node_by_plan.items()):
            if node not in reachable:
                del self._node_by_plan[plan]

    def _compile(self, plan: Plan) -> Node:
        node = self._node_by_plan.get(plan)
        if node is not None:
            return node
        inputs = tuple(self._compile(p) for p in plan.inputs)
        node = Node(plan, inputs)
        _init_node(node, self.tables)
        self._node_by_plan[plan] = node
        return node

    def _refresh_topo(self) -> None:
        order, seen = [], set()

        def visit(node):
            if node in seen:
                return
            seen.add(node)
            for child in node.inputs:
                visit(child)
            order.append(node)

        for sid in sorted(self.subscriptions):
            visit(self.subscriptions[sid])
        self._topo = order

    # -- transactions ------------------------------------------------------

    def apply_batch(self, changes, batch_id=None) -> list:
        """Commit one batch of (table, row, signed-delta) changes.

        Returns the publish records produced.  Raises (rolling the whole
        graph back) if any committed multiplicity would go negative.  A
        batch_id that was already committed is skipped silently so that
        replaying a persisted prefix never republishes.
        """
        batch_id = _freeze(batch_id) if batch_id is not None else None
        if batch_id is not None and batch_id in self.committed_batches:
            return []

        tdeltas = {}
        for table, row, delta in changes:
            if delta == 0:
                continue
            tdeltas.setdefault(table, defaultdict(int))[tuple(row)] += delta

        # Phase 1: validate committed base tables stay non-negative.
        for table, delta in tdeltas.items():
            current = self.tables.get(table, {})
            for row, mult in delta.items():
                if current.get(row, 0) + mult < 0:
                    raise NegativeMultiplicityError(
                        f"table {table!r} row {list(row)!r} would have "
                        f"negative multiplicity")

        # Phase 2: push deltas through the DAG; each shared node is
        # computed exactly once.  No state is mutated here.
        deltas = {}
        for node in self._topo:
            if node.plan.op == "scan":
                deltas[node] = dict(tdeltas.get(node.plan.table, {}))
            else:
                deltas[node] = _compute_delta(
                    node, [deltas[i] for i in node.inputs])

        # Phase 3: validate prospective committed node state.
        for node in self._topo:
            if node.plan.op != "scan":
                _validate(node, [deltas[i] for i in node.inputs])

        # Phase 4: commit.
        for table, delta in tdeltas.items():
            current = self.tables.setdefault(table, {})
            for row, mult in delta.items():
                new = current.get(row, 0) + mult
                if new == 0:
                    current.pop(row, None)
                else:
                    current[row] = new
        for node in self._topo:
            if node.plan.op != "scan":
                _apply(node, [deltas[i] for i in node.inputs])
        self.version += 1
        if batch_id is not None:
            self.committed_batches.add(batch_id)

        # Phase 5: publish, in deterministic (subscription, row) order.
        records = []
        for sid in sorted(self.subscriptions):
            delta = deltas[self.subscriptions[sid]]
            seq = 0
            for row in sorted(delta, key=row_sort_key):
                rec = {"version": self.version, "subscription": sid,
                       "seq": seq, "row": list(row), "delta": delta[row]}
                seq += 1
                records.append(rec)
                self.publish_log.append(rec)
        return records

    # -- persistence ---------------------------------------------------------

    def save(self, path: str) -> None:
        data = {
            "version": self.version,
            "committed_batches": sorted(self.committed_batches, key=repr),
            "tables": {
                name: [[list(row), mult]
                       for row, mult in sorted(
                           rows.items(), key=lambda kv: row_sort_key(kv[0]))]
                for name, rows in sorted(self.tables.items())
            },
            "subscriptions": {
                sid: node.plan.to_json()
                for sid, node in sorted(self.subscriptions.items())
            },
            "publish_log": self.publish_log,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)

    @classmethod
    def load(cls, path: str) -> "Engine":
        """Recover an engine from a persisted snapshot.

        Node state is rebuilt deterministically from the committed base
        tables; the publish log and committed batch ids are restored so
        that replayed batches are skipped instead of republished.
        """
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        engine = cls()
        engine.version = data["version"]
        engine.committed_batches = {_freeze(b) for b in data["committed_batches"]}
        engine.tables = {
            name: {tuple(row): mult for row, mult in rows}
            for name, rows in data["tables"].items()
        }
        engine.publish_log = [dict(rec) for rec in data["publish_log"]]
        for sid, plan_json in data["subscriptions"].items():
            engine.add_subscription(sid, plan_from_json(plan_json),
                                    publish_initial=False)
        return engine
