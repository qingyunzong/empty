"""Explicit finite alphabet, given as a set of code point ranges."""
from __future__ import annotations


class Alphabet:
    def __init__(self, ranges):
        merged = []
        for lo, hi in sorted((int(lo), int(hi)) for lo, hi in ranges):
            if lo > hi:
                continue
            if merged and lo <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
            else:
                merged.append((lo, hi))
        if not merged:
            raise ValueError("alphabet must be non-empty")
        self.ranges = tuple(merged)

    @classmethod
    def from_string(cls, s):
        return cls([(ord(c), ord(c)) for c in s])

    def contains(self, cp):
        return any(lo <= cp <= hi for lo, hi in self.ranges)

    def intervals(self):
        return self.ranges

    def chars(self):
        for lo, hi in self.ranges:
            yield from range(lo, hi + 1)

    def __eq__(self, other):
        return isinstance(other, Alphabet) and self.ranges == other.ranges

    def __hash__(self):
        return hash(self.ranges)

    def __repr__(self):
        return f"Alphabet({self.ranges!r})"

    def to_json(self):
        return [list(r) for r in self.ranges]

    @classmethod
    def from_json(cls, j):
        return cls([tuple(r) for r in j])


def parse_alphabet(spec):
    """Accept an Alphabet, a string of chars, or a list of [lo, hi] / "c"."""
    if spec is None:
        raise ValueError("alphabet is required")
    if isinstance(spec, Alphabet):
        return spec
    if isinstance(spec, str):
        return Alphabet.from_string(spec)
    ranges = []
    for item in spec:
        if isinstance(item, str):
            if len(item) != 1:
                raise ValueError(f"bad alphabet item: {item!r}")
            ranges.append((ord(item), ord(item)))
        else:
            lo, hi = item
            ranges.append((lo, hi))
    return Alphabet(ranges)
