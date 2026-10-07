"""Data model for the min-cost circulation library."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Edge:
    """A directed edge with lower/upper capacity bounds and integer cost."""

    id: str
    tail: str
    head: str
    lo: int
    hi: int
    cost: int

    @classmethod
    def from_dict(cls, data: dict) -> "Edge":
        return cls(
            id=str(data["id"]),
            tail=str(data["tail"]),
            head=str(data["head"]),
            lo=int(data["lo"]),
            hi=int(data["hi"]),
            cost=int(data["cost"]),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tail": self.tail,
            "head": self.head,
            "lo": self.lo,
            "hi": self.hi,
            "cost": self.cost,
        }


def normalize_edges(edges) -> list[Edge]:
    """Accept Edge instances or plain dicts and return Edge instances."""
    out = []
    for e in edges:
        out.append(e if isinstance(e, Edge) else Edge.from_dict(e))
    return out
