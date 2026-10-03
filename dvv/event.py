"""Events: uniquely identified updates carrying their causal context."""
from __future__ import annotations

from dataclasses import dataclass

from .context import CausalContext

PUT = "put"
DELETE = "del"
KINDS = (PUT, DELETE)


@dataclass(frozen=True)
class Event:
    dot: tuple                 # (node_id, epoch, counter) — globally unique
    key: str
    kind: str                  # PUT or DELETE
    value: object              # None for deletes
    context: CausalContext     # causal history including this event's own dot

    def dependencies(self):
        """Causal context without the event's own dot: everything that must
        be delivered before this event may be applied."""
        deps = CausalContext()
        for dot in self.context.dots():
            if dot != self.dot:
                deps.add(dot)
        return deps

    def to_json(self):
        return {
            "dot": list(self.dot),
            "key": self.key,
            "kind": self.kind,
            "value": self.value,
            "context": self.context.to_json(),
        }

    @classmethod
    def from_json(cls, data):
        if data["kind"] not in KINDS:
            raise ValueError(f"unknown event kind: {data['kind']!r}")
        return cls(
            dot=(data["dot"][0], int(data["dot"][1]), int(data["dot"][2])),
            key=data["key"],
            kind=data["kind"],
            value=data["value"],
            context=CausalContext.from_json(data["context"]),
        )
