"""Finite domains with canonical ordering and per-value costs.

Cost model:
  - int x:    cost = abs(x)
  - bool b:   cost = 0 if False else 1
  - list xs:  cost = len(xs) + sum(cost of elements)

Canonical order inside a domain sorts values by (cost, structural key), so
cost-0 values come first and ordering is total and deterministic.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product

from .errors import PolicyError


@dataclass(frozen=True)
class Domain:
    name: str
    kind: str
    values: tuple  # canonical order; list values stored as tuples
    costs: tuple   # cost per value, aligned with values


def _int_values(bound):
    return tuple(sorted(range(-bound, bound + 1), key=lambda v: (abs(v), v)))


def build_domain(name, spec, bound, max_len):
    kind = spec.get("type")
    if kind == "int":
        values = _int_values(bound)
        return Domain(name, "int", values, tuple(abs(v) for v in values))
    if kind == "bool":
        return Domain(name, "bool", (False, True), (0, 1))
    if kind == "list":
        elem_spec = spec.get("elem", {"type": "int"})
        elem = build_domain(name + "[]", elem_spec, bound, max_len)
        limit = spec.get("max_len", max_len)
        index_lists = []
        for length in range(limit + 1):
            for combo in product(range(len(elem.values)), repeat=length):
                index_lists.append(combo)

        def cost(idxs):
            return len(idxs) + sum(elem.costs[i] for i in idxs)

        index_lists.sort(key=lambda idxs: (cost(idxs), idxs))
        values = tuple(
            tuple(elem.values[i] for i in idxs) for idxs in index_lists
        )
        costs = tuple(cost(idxs) for idxs in index_lists)
        return Domain(name, "list", values, costs)
    raise PolicyError(f"unknown domain type {kind!r} for variable {name!r}")
