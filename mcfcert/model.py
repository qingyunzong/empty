"""Data model: networks with integer capacities, bounds, demands and costs."""

from __future__ import annotations

from dataclasses import dataclass


class NetworkError(ValueError):
    """Raised when a network or certificate description is malformed."""


def _require_int(value, what):
    if isinstance(value, bool) or not isinstance(value, int):
        raise NetworkError(f"{what} must be an integer, got {value!r}")
    return value


@dataclass(frozen=True)
class Edge:
    id: str
    tail: str
    head: str
    lower: int
    upper: int
    cost: int

    def to_dict(self):
        return {
            "id": self.id,
            "tail": self.tail,
            "head": self.head,
            "lower": self.lower,
            "upper": self.upper,
            "cost": self.cost,
        }


class Network:
    """A min-cost flow network with per-edge bounds and node demands.

    ``demands[v] > 0`` means node ``v`` must receive a net inflow of
    ``demands[v]``:  inflow(v) - outflow(v) == demands[v].
    """

    def __init__(self, nodes, edges, demands):
        self.nodes = list(nodes)
        self.edges = list(edges)
        self.demands = dict(demands)
        self._validate()
        self._index = {node: i for i, node in enumerate(self.nodes)}
        self._by_id = {edge.id: edge for edge in self.edges}

    def _validate(self):
        if len(set(self.nodes)) != len(self.nodes):
            raise NetworkError("duplicate node ids")
        node_set = set(self.nodes)
        seen = set()
        for edge in self.edges:
            if not isinstance(edge, Edge):
                raise NetworkError(f"edge must be an Edge, got {edge!r}")
            if edge.id in seen:
                raise NetworkError(f"duplicate edge id {edge.id!r}")
            seen.add(edge.id)
            for endpoint in (edge.tail, edge.head):
                if endpoint not in node_set:
                    raise NetworkError(
                        f"edge {edge.id!r} references unknown node {endpoint!r}"
                    )
            _require_int(edge.lower, f"edge {edge.id!r} lower bound")
            _require_int(edge.upper, f"edge {edge.id!r} upper bound")
            _require_int(edge.cost, f"edge {edge.id!r} cost")
            if edge.lower > edge.upper:
                raise NetworkError(f"edge {edge.id!r} has lower > upper")
        for node, value in self.demands.items():
            if node not in node_set:
                raise NetworkError(f"demand references unknown node {node!r}")
            _require_int(value, f"demand of node {node!r}")

    def demand(self, node):
        return self.demands.get(node, 0)

    def edge(self, edge_id):
        return self._by_id[edge_id]

    def node_index(self, node):
        return self._index[node]

    @classmethod
    def from_dict(cls, data):
        if not isinstance(data, dict):
            raise NetworkError("network must be a JSON object")
        try:
            nodes = [str(n) for n in data["nodes"]]
            edges = [
                Edge(
                    id=str(e["id"]),
                    tail=str(e["tail"]),
                    head=str(e["head"]),
                    lower=e["lower"],
                    upper=e["upper"],
                    cost=e["cost"],
                )
                for e in data.get("edges", [])
            ]
            demands = {str(k): v for k, v in data.get("demands", {}).items()}
        except (KeyError, TypeError, AttributeError) as exc:
            raise NetworkError(f"malformed network: {exc}") from exc
        return cls(nodes, edges, demands)

    def to_dict(self):
        return {
            "nodes": list(self.nodes),
            "edges": [e.to_dict() for e in self.edges],
            "demands": dict(self.demands),
        }


class Certificate:
    """An externally submitted min-cost flow certificate.

    Holds the proposed edge flows, node potentials and the declared total
    cost.  Any of them may be wrong; the verifier's job is to catch that.
    """

    def __init__(self, flows, potentials=None, declared_cost=None):
        self.flows = dict(flows)
        self.potentials = dict(potentials or {})
        self.declared_cost = declared_cost

    @classmethod
    def from_dict(cls, data):
        if not isinstance(data, dict):
            raise NetworkError("certificate must be a JSON object")
        flows = data.get("flows", {})
        potentials = data.get("potentials", {})
        if not isinstance(flows, dict) or not isinstance(potentials, dict):
            raise NetworkError("certificate flows/potentials must be objects")
        return cls(flows, potentials, data.get("declared_cost"))

    def to_dict(self):
        return {
            "flows": dict(self.flows),
            "potentials": dict(self.potentials),
            "declared_cost": self.declared_cost,
        }
