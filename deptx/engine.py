"""Transactional dependency-graph engine.

Layering model: each transaction layer is an overlay of changes
(key/value writes and added dependency edges) on top of the committed
base state plus all outer layers.  Committing an inner layer merges its
overlay into the next outer layer; only the outermost commit touches the
committed base.  Savepoints snapshot the current layer's overlay only,
so they never leak across layers.
"""

from __future__ import annotations


class TxError(Exception):
    """Base class for transactional errors; carries a process exit code."""

    exit_code = 1


class NoTransactionError(TxError):
    exit_code = 11


class UnknownSavepointError(TxError):
    exit_code = 10


class DependencyCycleError(TxError):
    exit_code = 3


class _Layer:
    __slots__ = ("kv", "edges", "savepoints", "savepoint_order")

    def __init__(self) -> None:
        self.kv: dict[str, str] = {}
        self.edges: set[tuple[str, str]] = set()
        self.savepoints: dict[str, tuple[dict[str, str], set[tuple[str, str]]]] = {}
        self.savepoint_order: list[str] = []


class Engine:
    def __init__(self) -> None:
        self._base_kv: dict[str, str] = {}
        self._base_edges: set[tuple[str, str]] = set()
        self._layers: list[_Layer] = []

    # -- introspection (used by tests / shadow comparison) ---------------

    @property
    def depth(self) -> int:
        return len(self._layers)

    def committed_state(self) -> tuple[dict[str, str], set[tuple[str, str]]]:
        return dict(self._base_kv), set(self._base_edges)

    # -- transaction structure -------------------------------------------

    def begin(self) -> None:
        self._layers.append(_Layer())

    def _require_layer(self) -> _Layer:
        if not self._layers:
            raise NoTransactionError("no active transaction")
        return self._layers[-1]

    def commit(self) -> None:
        layer = self._require_layer()
        self._layers.pop()
        if self._layers:
            parent = self._layers[-1]
            parent.kv.update(layer.kv)
            parent.edges |= layer.edges
        else:
            self._base_kv.update(layer.kv)
            self._base_edges |= layer.edges

    def rollback(self) -> None:
        self._require_layer()
        self._layers.pop()

    # -- savepoints (current layer only) -----------------------------------

    def savepoint(self, name: str) -> None:
        layer = self._require_layer()
        if name not in layer.savepoints:
            layer.savepoint_order.append(name)
        layer.savepoints[name] = (dict(layer.kv), set(layer.edges))

    def undo(self, name: str) -> None:
        layer = self._require_layer()
        snapshot = layer.savepoints.get(name)
        if snapshot is None:
            raise UnknownSavepointError(f"unknown savepoint in current layer: {name}")
        kv, edges = snapshot
        layer.kv = dict(kv)
        layer.edges = set(edges)
        idx = layer.savepoint_order.index(name)
        for later in layer.savepoint_order[idx + 1:]:
            del layer.savepoints[later]
        del layer.savepoint_order[idx + 1:]

    # -- data operations ---------------------------------------------------

    def set(self, key: str, value: str) -> None:
        self._require_layer().kv[key] = value

    def get(self, key: str) -> str | None:
        for layer in reversed(self._layers):
            if key in layer.kv:
                return layer.kv[key]
        return self._base_kv.get(key)

    def depend(self, source: str, target: str) -> None:
        layer = self._require_layer()
        edges = self._visible_edges()
        if source == target or self._reaches(edges, target, source):
            raise DependencyCycleError(
                f"dependency {source} -> {target} would create a cycle"
            )
        layer.edges.add((source, target))

    # -- helpers -----------------------------------------------------------

    def _visible_edges(self) -> set[tuple[str, str]]:
        edges = set(self._base_edges)
        for layer in self._layers:
            edges |= layer.edges
        return edges

    @staticmethod
    def _reaches(edges: set[tuple[str, str]], start: str, target: str) -> bool:
        adjacency: dict[str, set[str]] = {}
        for src, dst in edges:
            adjacency.setdefault(src, set()).add(dst)
        stack = [start]
        seen = {start}
        while stack:
            node = stack.pop()
            if node == target:
                return True
            for nxt in adjacency.get(node, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return False
