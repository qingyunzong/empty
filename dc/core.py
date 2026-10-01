"""Transactional undirected-graph store with WAL-based crash recovery."""

from __future__ import annotations

import json
import os
import tempfile
from collections import deque

GRAPH_FILE = "graph.json"
WAL_FILE = "wal.log"


class SemanticError(Exception):
    """Raised for semantic violations that must roll back the transaction."""


class TxFormatError(Exception):
    """Raised when the transaction document is structurally invalid."""


def _fsync(f):
    f.flush()
    os.fsync(f.fileno())


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path, payload):
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
            _fsync(f)
        os.replace(tmp, path)
        _fsync_dir(directory)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def empty_graph():
    return {"nodes": [], "edges": [], "last_tx": None, "last_results": []}


def load_graph(state_dir):
    path = os.path.join(state_dir, GRAPH_FILE)
    if not os.path.exists(path):
        return empty_graph()
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_graph(state_dir, graph):
    _atomic_write(
        os.path.join(state_dir, GRAPH_FILE),
        json.dumps(graph, indent=2, sort_keys=True),
    )


def read_wal(state_dir):
    path = os.path.join(state_dir, WAL_FILE)
    records = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    return records


def append_wal(state_dir, record):
    path = os.path.join(state_dir, WAL_FILE)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")
        _fsync(f)


def rewrite_wal(state_dir, records):
    payload = "".join(json.dumps(r, sort_keys=True) + "\n" for r in records)
    _atomic_write(os.path.join(state_dir, WAL_FILE), payload)


def connected(nodes, edges, src, dst):
    adjacency = {n: set() for n in nodes}
    for u, v in edges:
        adjacency.setdefault(u, set()).add(v)
        adjacency.setdefault(v, set()).add(u)
    seen = {src}
    queue = deque([src])
    while queue:
        node = queue.popleft()
        if node == dst:
            return True
        for nxt in adjacency.get(node, ()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return False


def validate_tx(tx):
    if not isinstance(tx, dict):
        raise TxFormatError("transaction must be a JSON object")
    if not isinstance(tx.get("id"), str) or not tx["id"]:
        raise TxFormatError("transaction requires a non-empty string 'id'")
    ops = tx.get("ops")
    if not isinstance(ops, list):
        raise TxFormatError("transaction requires a list 'ops'")
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            raise TxFormatError(f"ops[{i}] must be an object")
        if op.get("op") not in ("add", "remove", "query"):
            raise TxFormatError(f"ops[{i}] has unknown op {op.get('op')!r}")
        for field in ("u", "v"):
            if not isinstance(op.get(field), str) or not op[field]:
                raise TxFormatError(f"ops[{i}] requires a non-empty string '{field}'")


def _edge_key(u, v):
    return (u, v) if u <= v else (v, u)


def _apply_mutation(nodes, edges, record):
    key = _edge_key(record["u"], record["v"])
    if record["type"] == "add":
        nodes.add(record["u"])
        nodes.add(record["v"])
        edges.add(key)
    elif record["type"] == "remove":
        edges.discard(key)


def recover(state_dir):
    """Replay committed-but-uninstalled transactions and drop partial ones."""
    graph = load_graph(state_dir)
    records = read_wal(state_dir)
    if not records:
        return graph
    nodes = set(graph["nodes"])
    edges = {tuple(e) for e in graph["edges"]}
    pending = []
    dirty = False
    for record in records:
        if record["type"] == "commit":
            if graph["last_tx"] != record["tx"]:
                for mutation in pending:
                    _apply_mutation(nodes, edges, mutation)
                graph["last_tx"] = record["tx"]
                graph["last_results"] = record["results"]
                dirty = True
            pending = []
        else:
            pending.append(record)
    # Any leftover pending records belong to an uncommitted transaction:
    # they are discarded so the partial transaction is cleared.
    if dirty:
        graph["nodes"] = sorted(nodes)
        graph["edges"] = sorted(list(e) for e in edges)
        save_graph(state_dir, graph)
    rewrite_wal(state_dir, [])
    return graph


def run_tx(state_dir, tx, fail_after=None):
    """Execute a transaction. Returns the list of query results."""
    graph = recover(state_dir)
    if graph["last_tx"] == tx["id"]:
        # Same transaction id already committed: idempotent replay.
        return graph["last_results"]

    nodes = set(graph["nodes"])
    edges = {tuple(e) for e in graph["edges"]}
    results = []
    durable = 0
    try:
        for op in tx["ops"]:
            kind = op["op"]
            u, v = op["u"], op["v"]
            if kind == "query":
                if u not in nodes or v not in nodes:
                    raise SemanticError(
                        f"query references uninitialized node(s): {u!r}, {v!r}"
                    )
                results.append(
                    {"u": u, "v": v, "connected": connected(nodes, edges, u, v)}
                )
                continue
            if kind == "remove":
                if u not in nodes or v not in nodes:
                    raise SemanticError(
                        f"remove references uninitialized node(s): {u!r}, {v!r}"
                    )
                if _edge_key(u, v) not in edges:
                    raise SemanticError(f"remove of non-existent edge {u!r}-{v!r}")
            # Durable WAL record before applying the mutation.
            append_wal(state_dir, {"tx": tx["id"], "type": kind, "u": u, "v": v})
            durable += 1
            if fail_after is not None and durable >= fail_after:
                # Simulated crash: K durable records exist, no commit record.
                os._exit(3)
            _apply_mutation(nodes, edges, {"type": kind, "u": u, "v": v})
    except SemanticError:
        # Roll back: clear this transaction's partial WAL records.
        rewrite_wal(state_dir, [])
        raise

    append_wal(
        state_dir,
        {"tx": tx["id"], "type": "commit", "results": results},
    )
    new_graph = {
        "nodes": sorted(nodes),
        "edges": sorted(list(e) for e in edges),
        "last_tx": tx["id"],
        "last_results": results,
    }
    save_graph(state_dir, new_graph)
    rewrite_wal(state_dir, [])
    return results
