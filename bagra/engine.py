"""Incremental bag-relational-algebra engine.

A query is a DAG of operator nodes over base tables.  Clients commit
batches of signed table edits; the engine propagates deltas through the
graph in topological order (shared subexpressions are updated exactly
once per batch), validates non-negativity of every committed base table
and every node result, and on any error rolls the whole graph back to
its pre-batch state.  Successful batches bump the version and publish
deterministically ordered change records to subscriptions.  State can
be persisted to JSON and recovered; recovery never re-publishes.
"""

import json
import os

from .operators import BagraError, ScanNode, build_node


def row_sort_key(row):
    return json.dumps(list(row))


class Engine:
    def __init__(self):
        self.tables = {}
        self.nodes = {}
        self.topo = []
        self._node_specs = []
        self.subscriptions = {}
        self.next_sub_id = 1
        self.version = 0
        self.seq = 0
        self.publish_log = []
        self.stats = {"node_apply": {}}

    # ----- graph construction -------------------------------------------------

    def add_table(self, name):
        if name in self.tables:
            raise BagraError(f"duplicate table: {name!r}")
        self.tables[name] = {}

    def add_node(self, spec):
        spec = dict(spec)
        node_id = spec["id"]
        if node_id in self.nodes:
            raise BagraError(f"duplicate node id: {node_id!r}")
        node = build_node(spec)
        if isinstance(node, ScanNode):
            if node.table not in self.tables:
                raise BagraError(f"unknown table: {node.table!r}")
            node.parents = []
        else:
            parents = list(spec.get("inputs", []))
            for parent in parents:
                if parent not in self.nodes:
                    raise BagraError(f"unknown input node: {parent!r}")
            node.parents = parents
        self.nodes[node_id] = node
        self._node_specs.append(spec)
        self._retopo()
        return node_id

    def _retopo(self):
        order = []
        mark = {}

        def visit(nid):
            state = mark.get(nid)
            if state == "done":
                return
            if state == "open":
                raise BagraError("cycle in query graph")
            mark[nid] = "open"
            for parent in self.nodes[nid].parents:
                visit(parent)
            mark[nid] = "done"
            order.append(nid)

        for nid in self.nodes:
            visit(nid)
        self.topo = order

    # ----- subscriptions ------------------------------------------------------

    def subscribe(self, node_id):
        if node_id not in self.nodes:
            raise BagraError(f"unknown node: {node_id!r}")
        sid = self.next_sub_id
        self.next_sub_id += 1
        self.subscriptions[sid] = node_id
        return sid

    def unsubscribe(self, sid):
        if sid not in self.subscriptions:
            raise BagraError(f"unknown subscription: {sid!r}")
        del self.subscriptions[sid]

    # ----- batches ------------------------------------------------------------

    def _snapshot(self):
        return (
            {name: dict(data) for name, data in self.tables.items()},
            {nid: node.snapshot() for nid, node in self.nodes.items()},
        )

    def _restore(self, snap):
        tables, nodes = snap
        for name, data in tables.items():
            self.tables[name] = dict(data)
        for nid, state in nodes.items():
            self.nodes[nid].restore(state)

    def apply_batch(self, changes):
        """Commit one batch of {table: [(row, signed_delta), ...]} edits.

        Returns the list of publish records for this batch.  On any error
        the entire graph (tables and all node state) is rolled back and
        nothing is published.
        """
        snap = self._snapshot()
        try:
            table_deltas = self._apply_table_changes(changes)
            deltas = {}
            for nid in self.topo:
                node = self.nodes[nid]
                if isinstance(node, ScanNode):
                    inputs = [table_deltas.get(node.table, {})]
                else:
                    inputs = [deltas[p] for p in node.parents]
                out = node.apply(inputs)
                self.stats["node_apply"][nid] = self.stats["node_apply"].get(nid, 0) + 1
                self._check_non_negative(nid, node.state)
                deltas[nid] = out
        except Exception:
            self._restore(snap)
            raise
        self.version += 1
        return self._publish(deltas)

    def _apply_table_changes(self, changes):
        table_deltas = {}
        for name, edits in changes.items():
            if name not in self.tables:
                raise BagraError(f"unknown table: {name!r}")
            table = self.tables[name]
            delta = {}
            for row, count in edits:
                row = tuple(row)
                if not isinstance(count, int) or isinstance(count, bool):
                    raise BagraError(f"delta must be an integer, got {count!r}")
                delta[row] = delta.get(row, 0) + count
            delta = {row: d for row, d in delta.items() if d}
            for row, d in delta.items():
                new = table.get(row, 0) + d
                if new < 0:
                    raise BagraError(
                        f"negative multiplicity {new} for row {row!r} in table {name!r}"
                    )
                if new:
                    table[row] = new
                else:
                    table.pop(row, None)
            table_deltas[name] = delta
        return table_deltas

    @staticmethod
    def _check_non_negative(nid, state):
        for row, count in state.items():
            if count < 0:
                raise BagraError(
                    f"negative multiplicity {count} for row {row!r} in node {nid!r}"
                )

    def _publish(self, deltas):
        records = []
        for sid in sorted(self.subscriptions):
            node_id = self.subscriptions[sid]
            delta = deltas.get(node_id) or {}
            if not delta:
                continue
            self.seq += 1
            record = {
                "version": self.version,
                "seq": self.seq,
                "subscription": sid,
                "node": node_id,
                "changes": [
                    [list(row), count]
                    for row, count in sorted(delta.items(), key=lambda kv: row_sort_key(kv[0]))
                ],
            }
            self.publish_log.append(record)
            records.append(record)
        return records

    # ----- inspection ---------------------------------------------------------

    def result(self, node_id):
        if node_id not in self.nodes:
            raise BagraError(f"unknown node: {node_id!r}")
        state = self.nodes[node_id].state
        return [
            [list(row), count]
            for row, count in sorted(state.items(), key=lambda kv: row_sort_key(kv[0]))
        ]

    def table(self, name):
        if name not in self.tables:
            raise BagraError(f"unknown table: {name!r}")
        return [
            [list(row), count]
            for row, count in sorted(self.tables[name].items(), key=lambda kv: row_sort_key(kv[0]))
        ]

    # ----- persistence --------------------------------------------------------

    def save(self, path):
        data = {
            "format": 1,
            "version": self.version,
            "seq": self.seq,
            "next_sub_id": self.next_sub_id,
            "tables": {
                name: [[list(row), count] for row, count in
                       sorted(t.items(), key=lambda kv: row_sort_key(kv[0]))]
                for name, t in self.tables.items()
            },
            "nodes": self._node_specs,
            "subscriptions": {str(sid): nid for sid, nid in self.subscriptions.items()},
            "publish_log": self.publish_log,
        }
        tmp = f"{path}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, path)

    @classmethod
    def load(cls, path):
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("format") != 1:
            raise BagraError("unsupported state format")
        eng = cls()
        for name in data["tables"]:
            eng.add_table(name)
        for spec in data["nodes"]:
            eng.add_node(spec)
        for name, rows in data["tables"].items():
            eng.tables[name] = {tuple(row): count for row, count in rows if count}
        eng.version = data["version"]
        eng.seq = data["seq"]
        eng.next_sub_id = data["next_sub_id"]
        eng.subscriptions = {int(sid): nid for sid, nid in data["subscriptions"].items()}
        eng.publish_log = list(data["publish_log"])
        eng._recompute()
        return eng

    def _recompute(self):
        """Rebuild derived node state from committed base tables.

        Recovery only: does not touch the version and never publishes,
        so replaying a persisted state cannot duplicate publish records.
        """
        deltas = {}
        for nid in self.topo:
            node = self.nodes[nid]
            if isinstance(node, ScanNode):
                inputs = [dict(self.tables[node.table])]
            else:
                inputs = [deltas[p] for p in node.parents]
            deltas[nid] = node.apply(inputs)
            self._check_non_negative(nid, node.state)
