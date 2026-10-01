"""Dependency-graph transactional store.

Layered (delta) implementation:
  - Each transaction layer records only its own writes / added edges.
  - commit merges the top layer into the layer below (or into the
    committed state when it is the outermost layer).
  - rollback discards the top layer entirely.
  - savepoints are layer-local snapshots; undo restores the layer to
    the snapshot and drops savepoints created after it.
"""

ERR_CYCLE = 3
ERR_NO_SAVEPOINT = 10
ERR_NO_TX = 11


class TxError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class _Layer:
    __slots__ = ("writes", "edges", "savepoints")

    def __init__(self):
        self.writes = {}        # key -> value set in this layer
        self.edges = set()      # (a, b) edges added in this layer
        self.savepoints = {}    # name -> (writes_copy, edges_copy), insertion ordered


def _reaches(edges, start, target):
    """True if target is reachable from start (zero-length path counts)."""
    if start == target:
        return True
    adj = {}
    for a, b in edges:
        adj.setdefault(a, set()).add(b)
    seen = {start}
    stack = [start]
    while stack:
        node = stack.pop()
        for nxt in adj.get(node, ()):
            if nxt == target:
                return True
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return False


class Store:
    def __init__(self):
        self._committed = {}
        self._committed_edges = set()
        self._layers = []

    # -- helpers ---------------------------------------------------------
    def _require_tx(self):
        if not self._layers:
            raise TxError(ERR_NO_TX, "no active transaction")
        return self._layers[-1]

    def _effective_edges(self):
        edges = set(self._committed_edges)
        for layer in self._layers:
            edges |= layer.edges
        return edges

    # -- commands --------------------------------------------------------
    def begin(self):
        self._layers.append(_Layer())

    def set(self, key, value):
        self._require_tx().writes[key] = value

    def depend(self, a, b):
        layer = self._require_tx()
        edges = self._effective_edges()
        if _reaches(edges, b, a):
            raise TxError(ERR_CYCLE, "dependency cycle: %s -> %s" % (a, b))
        layer.edges.add((a, b))

    def commit(self):
        layer = self._require_tx()
        self._layers.pop()
        if self._layers:
            parent = self._layers[-1]
            parent.writes.update(layer.writes)
            parent.edges |= layer.edges
        else:
            self._committed.update(layer.writes)
            self._committed_edges |= layer.edges

    def rollback(self):
        self._require_tx()
        self._layers.pop()

    def savepoint(self, name):
        layer = self._require_tx()
        if name in layer.savepoints:
            del layer.savepoints[name]  # redefine: move to the end
        layer.savepoints[name] = (dict(layer.writes), set(layer.edges))

    def undo(self, name):
        layer = self._require_tx()
        if name not in layer.savepoints:
            raise TxError(ERR_NO_SAVEPOINT, "unknown savepoint: %s" % name)
        writes, edges = layer.savepoints[name]
        layer.writes = dict(writes)
        layer.edges = set(edges)
        names = list(layer.savepoints)
        for later in names[names.index(name) + 1:]:
            del layer.savepoints[later]

    def get(self, key):
        self._require_tx()
        for layer in reversed(self._layers):
            if key in layer.writes:
                return layer.writes[key]
        return self._committed.get(key)
