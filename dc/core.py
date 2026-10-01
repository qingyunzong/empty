import json
import os


class SemanticError(Exception):
    """Raised when a transaction operation violates graph semantics."""


class CrashRequested(Exception):
    """Raised to simulate a crash after --fail-after durable WAL records."""


class Graph:
    """Undirected graph over string nodes."""

    def __init__(self, nodes=(), edges=()):
        self.nodes = set(nodes)
        self.edges = set()
        for u, v in edges:
            self.edges.add(self.key(u, v))

    @staticmethod
    def key(u, v):
        return (u, v) if u <= v else (v, u)

    def copy(self):
        return Graph(self.nodes, self.edges)

    def add_edge(self, u, v):
        self.nodes.add(u)
        self.nodes.add(v)
        self.edges.add(self.key(u, v))

    def remove_edge(self, u, v):
        self.edges.discard(self.key(u, v))

    def has_edge(self, u, v):
        return self.key(u, v) in self.edges

    def connected(self, source, target):
        if source == target:
            return True
        adjacency = {}
        for u, v in self.edges:
            adjacency.setdefault(u, set()).add(v)
            adjacency.setdefault(v, set()).add(u)
        seen = {source}
        stack = [source]
        while stack:
            node = stack.pop()
            for nxt in adjacency.get(node, ()):
                if nxt == target:
                    return True
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return False

    def to_json(self):
        return {
            "nodes": sorted(self.nodes),
            "edges": [list(edge) for edge in sorted(self.edges)],
        }

    @classmethod
    def from_json(cls, data):
        return cls(data.get("nodes", []), data.get("edges", []))


class Store:
    """Persistent state: committed graph, committed tx results, WAL."""

    def __init__(self, state_dir):
        self.state_dir = state_dir
        os.makedirs(state_dir, exist_ok=True)
        self.graph_path = os.path.join(state_dir, "graph.json")
        self.committed_path = os.path.join(state_dir, "committed.json")
        self.wal_path = os.path.join(state_dir, "wal.jsonl")

    def load_graph(self):
        try:
            with open(self.graph_path, "r", encoding="utf-8") as f:
                return Graph.from_json(json.load(f))
        except FileNotFoundError:
            return Graph()

    def save_graph(self, graph):
        self._atomic_write(self.graph_path, json.dumps(graph.to_json()))

    def load_committed(self):
        try:
            with open(self.committed_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
            return {}
        except FileNotFoundError:
            return {}

    def save_committed(self, committed):
        self._atomic_write(self.committed_path, json.dumps(committed))

    def _atomic_write(self, path, text):
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        dir_fd = os.open(self.state_dir, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    def read_wal(self):
        records = []
        try:
            with open(self.wal_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        break  # ignore torn tail
        except FileNotFoundError:
            pass
        return records

    def truncate_wal(self):
        with open(self.wal_path, "w", encoding="utf-8") as f:
            f.flush()
            os.fsync(f.fileno())


class WalAppender:
    """Appends WAL records with flush+fsync; simulates crash via fail_after."""

    def __init__(self, store, fail_after=None):
        self.store = store
        self.fail_after = fail_after
        self.count = 0
        if fail_after is not None and fail_after <= 0:
            raise CrashRequested

    def append(self, record):
        with open(self.store.wal_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self.count += 1
        if self.fail_after is not None and self.count >= self.fail_after:
            raise CrashRequested


def load_transaction(path):
    """Load and validate a transaction file. Raises ValueError/OSError."""
    with open(path, "r", encoding="utf-8") as f:
        tx = json.load(f)
    if not isinstance(tx, dict):
        raise ValueError("transaction must be a JSON object")
    if not isinstance(tx.get("id"), str):
        raise ValueError("transaction must have a string 'id'")
    ops = tx.get("ops")
    if not isinstance(ops, list):
        raise ValueError("transaction must have an 'ops' list")
    for op in ops:
        if not isinstance(op, dict):
            raise ValueError("each op must be an object")
        if op.get("op") not in ("add", "remove", "query"):
            raise ValueError("op must be one of add/remove/query")
        if not isinstance(op.get("u"), str) or not isinstance(op.get("v"), str):
            raise ValueError("op endpoints 'u' and 'v' must be strings")
    return tx


def recover(store, graph, committed):
    """Resolve any WAL left by a previous run.

    - Committed transaction in WAL: finish installing it (idempotent).
    - Incomplete transaction in WAL: discard it entirely.
    """
    records = store.read_wal()
    if not records:
        return
    commit = None
    for rec in records:
        if isinstance(rec, dict) and rec.get("type") == "commit":
            commit = rec
    if commit is not None:
        started = False
        for rec in records:
            if rec is commit:
                break
            if isinstance(rec, dict) and rec.get("type") == "begin" \
                    and rec.get("id") == commit.get("id"):
                started = True
                continue
            if started and isinstance(rec, dict) and rec.get("type") == "op":
                if rec.get("op") == "add":
                    graph.add_edge(rec["u"], rec["v"])
                elif rec.get("op") == "remove":
                    graph.remove_edge(rec["u"], rec["v"])
        store.save_graph(graph)
        committed[commit["id"]] = commit.get("results", [])
        store.save_committed(committed)
    store.truncate_wal()


def execute(store, tx, fail_after=None):
    """Run a transaction. Returns (exit_code, results)."""
    graph = store.load_graph()
    committed = store.load_committed()
    recover(store, graph, committed)

    tx_id = tx["id"]
    if tx_id in committed:
        # Same id already committed: idempotent replay of old results.
        return 0, committed[tx_id]

    wal = WalAppender(store, fail_after)
    working = graph.copy()
    results = []
    try:
        wal.append({"type": "begin", "id": tx_id})
        for op in tx["ops"]:
            kind = op["op"]
            u = op["u"]
            v = op["v"]
            if kind == "add":
                wal.append({"type": "op", "op": "add", "u": u, "v": v})
                working.add_edge(u, v)
            elif kind == "remove":
                if u not in working.nodes or v not in working.nodes:
                    raise SemanticError(
                        "remove references uninitialized node: %r, %r" % (u, v))
                if not working.has_edge(u, v):
                    raise SemanticError(
                        "remove of nonexistent edge: %r, %r" % (u, v))
                wal.append({"type": "op", "op": "remove", "u": u, "v": v})
                working.remove_edge(u, v)
            else:  # query
                if u not in working.nodes or v not in working.nodes:
                    raise SemanticError(
                        "query references uninitialized node: %r, %r" % (u, v))
                results.append(working.connected(u, v))
        wal.append({"type": "commit", "id": tx_id, "results": results})
    except SemanticError:
        store.truncate_wal()  # roll back: discard partial WAL
        raise

    store.save_graph(working)
    committed[tx_id] = results
    store.save_committed(committed)
    store.truncate_wal()
    return 0, results
