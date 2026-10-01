"""Dotted version vectors with epochs and compressible causal contexts.

A dot is a globally unique update identifier ``(node, epoch, counter)``.
A :class:`CausalContext` stores, per ``(node, epoch)`` stream, the maximal
*contiguous* counter plus a set of non-contiguous dots.  Compression never
loses information: a gap in a stream is kept as explicit dots, so a context
like ``{1, 3}`` can never masquerade as the contiguous prefix ``{1, 2, 3}``.
"""
from __future__ import annotations

from typing import Dict, FrozenSet, Iterable, Iterator, Tuple

Dot = Tuple[str, int, int]  # (node, epoch, counter)
StreamKey = Tuple[str, int]  # (node, epoch)


def stream_of(dot: Dot) -> StreamKey:
    return (dot[0], dot[1])


class CausalContext:
    """Compressed causal context: contiguous prefixes + explicit gap dots."""

    __slots__ = ("clock", "dots")

    def __init__(
        self,
        clock: Dict[StreamKey, int] | None = None,
        dots: Iterable[Dot] | None = None,
        _normalize: bool = True,
    ):
        self.clock: Dict[StreamKey, int] = {
            tuple(k): v for k, v in (clock or {}).items() if v > 0
        }
        self.dots: FrozenSet[Dot] = frozenset(dots or ())
        if _normalize:
            self._normalize()

    def _normalize(self) -> None:
        clock = self.clock
        dots = {d for d in self.dots if d[2] > clock.get((d[0], d[1]), 0)}
        changed = True
        while changed:
            changed = False
            for d in list(dots):
                key = (d[0], d[1])
                if d[2] == clock.get(key, 0) + 1:
                    clock[key] = d[2]
                    dots.discard(d)
                    changed = True
        self.dots = frozenset(dots)

    @classmethod
    def empty(cls) -> "CausalContext":
        return cls()

    @classmethod
    def from_points(cls, points: Iterable[Dot]) -> "CausalContext":
        return cls({}, set(points))

    def contains(self, dot: Dot) -> bool:
        return dot[2] <= self.clock.get((dot[0], dot[1]), 0) or dot in self.dots

    def leq(self, other: "CausalContext") -> bool:
        for key, cnt in self.clock.items():
            # A contiguous prefix can only be covered by a contiguous prefix;
            # explicit dots in `other` never fill gaps silently.
            if other.clock.get(key, 0) < cnt:
                return False
        return all(other.contains(d) for d in self.dots)

    def dominates(self, other: "CausalContext") -> bool:
        return other.leq(self) and self != other

    def concurrent(self, other: "CausalContext") -> bool:
        return not self.leq(other) and not other.leq(self)

    def is_empty(self) -> bool:
        return not self.clock and not self.dots

    def add(self, dot: Dot) -> "CausalContext":
        return CausalContext(self.clock, self.dots | {dot})

    def merge(self, other: "CausalContext") -> "CausalContext":
        clock = dict(self.clock)
        for key, cnt in other.clock.items():
            if cnt > clock.get(key, 0):
                clock[key] = cnt
        return CausalContext(clock, self.dots | other.dots)

    def minus(self, dot: Dot) -> "CausalContext":
        """Context with exactly ``dot`` removed (dependency extraction)."""
        points = set(self.points())
        points.discard(dot)
        return CausalContext.from_points(points)

    def points(self) -> Iterator[Dot]:
        for (node, epoch), cnt in self.clock.items():
            for c in range(1, cnt + 1):
                yield (node, epoch, c)
        yield from self.dots

    def next_dot(self, node: str, epoch: int) -> Dot:
        return (node, epoch, self.clock.get((node, epoch), 0) + 1)

    def to_json(self) -> dict:
        return {
            "clock": [[n, e, c] for (n, e), c in sorted(self.clock.items())],
            "dots": sorted([list(d) for d in self.dots]),
        }

    @classmethod
    def from_json(cls, data: dict) -> "CausalContext":
        clock = {(n, e): c for n, e, c in data.get("clock", [])}
        dots = {tuple(d) for d in data.get("dots", [])}
        return cls(clock, dots)

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, CausalContext)
            and self.clock == other.clock
            and self.dots == other.dots
        )

    def __hash__(self) -> int:
        return hash((frozenset(self.clock.items()), self.dots))

    def __repr__(self) -> str:
        return f"CausalContext(clock={self.clock}, dots={sorted(self.dots)})"
