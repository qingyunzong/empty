"""Network model for the min-cost flow certificate verifier / repairer."""

from __future__ import annotations

from dataclasses import dataclass


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclass(frozen=True)
class Edge:
    id: str
    tail: str
    head: str
    lower: int
    upper: int
    cost: int


class Network:
    """Directed network with integer capacities, lower bounds, demands, costs.

    demands[v] > 0 means node v must receive a net inflow of demands[v]
    (inflow - outflow == demands[v]).  Sum of demands must be zero.
    """

    def __init__(self, nodes, edges, demands):
        self.edges = list(edges)
        seen = set()
        ordered = []
        for node in nodes or []:
            if node not in seen:
                seen.add(node)
                ordered.append(node)
        for edge in self.edges:
            for endpoint in (edge.tail, edge.head):
                if endpoint not in seen:
                    seen.add(endpoint)
                    ordered.append(endpoint)
        self.demands = {}
        for node, value in (demands or {}).items():
            if not _is_int(value):
                raise ValueError(f"demand of node {node!r} is not an integer")
            if node not in seen:
                seen.add(node)
                ordered.append(node)
            self.demands[node] = value
        self.nodes = ordered
        for node in self.nodes:
            self.demands.setdefault(node, 0)

        ids = set()
        for edge in self.edges:
            if edge.id in ids:
                raise ValueError(f"duplicate edge id {edge.id!r}")
            ids.add(edge.id)
            for name, value in (("lower", edge.lower), ("upper", edge.upper),
                                ("cost", edge.cost)):
                if not _is_int(value):
                    raise ValueError(f"edge {edge.id!r}: {name} is not an integer")
            if edge.lower < 0:
                raise ValueError(f"edge {edge.id!r}: lower bound must be >= 0")
            if edge.lower > edge.upper:
                raise ValueError(f"edge {edge.id!r}: lower bound exceeds upper bound")
        if sum(self.demands.values()) != 0:
            raise ValueError("demands do not sum to zero")
        self._edge_by_id = {edge.id: edge for edge in self.edges}

    def edge(self, edge_id) -> Edge:
        return self._edge_by_id[edge_id]

    @classmethod
    def from_dict(cls, data) -> "Network":
        if not isinstance(data, dict):
            raise ValueError("network must be a JSON object")
        edges = []
        for raw in data.get("edges", []):
            edges.append(Edge(
                id=raw["id"],
                tail=raw["tail"],
                head=raw["head"],
                lower=raw.get("lower", 0),
                upper=raw["upper"],
                cost=raw.get("cost", 0),
            ))
        return cls(nodes=data.get("nodes"), edges=edges,
                   demands=data.get("demands"))

    def to_dict(self) -> dict:
        return {
            "nodes": list(self.nodes),
            "edges": [
                {"id": e.id, "tail": e.tail, "head": e.head, "lower": e.lower,
                 "upper": e.upper, "cost": e.cost}
                for e in self.edges
            ],
            "demands": {v: d for v, d in self.demands.items()},
        }
