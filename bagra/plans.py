"""Plan and predicate definitions for the incremental bag relational algebra.

Plans are immutable, hashable, and JSON-serializable so that structurally
identical subexpressions can be shared (hash-consed) across subscriptions
and so that subscriptions can be persisted and recovered.
"""
from __future__ import annotations

from dataclasses import dataclass

# NULL is represented by None.  Join keys containing NULL never match
# (SQL semantics), while set-identity operations (distinct, project,
# intersect_all, except_all) treat NULL as an ordinary value.

OPS = (
    "scan",
    "filter",
    "project",
    "join",
    "union_all",
    "intersect_all",
    "except_all",
    "distinct",
)

CMP_OPS = ("eq", "ne", "lt", "le", "gt", "ge", "is_null", "not_null")


class Pred:
    def test(self, row: tuple) -> bool:  # pragma: no cover - abstract
        raise NotImplementedError

    def to_json(self):  # pragma: no cover - abstract
        raise NotImplementedError


@dataclass(frozen=True)
class Cmp(Pred):
    """Comparison of a column against a constant.

    Any comparison involving NULL (except is_null / not_null) is false,
    matching SQL three-valued logic for the WHERE clause.
    """

    op: str
    col: int
    value: object = None

    def __post_init__(self):
        if self.op not in CMP_OPS:
            raise ValueError(f"unknown comparison op {self.op!r}")

    def test(self, row: tuple) -> bool:
        v = row[self.col]
        if self.op == "is_null":
            return v is None
        if self.op == "not_null":
            return v is not None
        if v is None or self.value is None:
            return False
        if self.op == "eq":
            return v == self.value
        if self.op == "ne":
            return v != self.value
        if self.op == "lt":
            return v < self.value
        if self.op == "le":
            return v <= self.value
        if self.op == "gt":
            return v > self.value
        if self.op == "ge":
            return v >= self.value
        raise AssertionError(self.op)  # pragma: no cover

    def to_json(self):
        return {"kind": "cmp", "op": self.op, "col": self.col, "value": self.value}


@dataclass(frozen=True)
class And(Pred):
    parts: tuple

    def test(self, row: tuple) -> bool:
        return all(p.test(row) for p in self.parts)

    def to_json(self):
        return {"kind": "and", "parts": [p.to_json() for p in self.parts]}


@dataclass(frozen=True)
class Or(Pred):
    parts: tuple

    def test(self, row: tuple) -> bool:
        return any(p.test(row) for p in self.parts)

    def to_json(self):
        return {"kind": "or", "parts": [p.to_json() for p in self.parts]}


@dataclass(frozen=True)
class Not(Pred):
    part: Pred

    def test(self, row: tuple) -> bool:
        return not self.part.test(row)

    def to_json(self):
        return {"kind": "not", "part": self.part.to_json()}


def pred_from_json(data) -> Pred:
    kind = data["kind"]
    if kind == "cmp":
        return Cmp(data["op"], data["col"], data.get("value"))
    if kind == "and":
        return And(tuple(pred_from_json(p) for p in data["parts"]))
    if kind == "or":
        return Or(tuple(pred_from_json(p) for p in data["parts"]))
    if kind == "not":
        return Not(pred_from_json(data["part"]))
    raise ValueError(f"unknown predicate kind {kind!r}")


@dataclass(frozen=True)
class Plan:
    """A relational algebra operator node.

    inputs: child plans (0 for scan, 1 for unary ops, 2 for binary ops).
    cols: projection columns, or left join key columns for join.
    right_cols: right join key columns (join only).
    """

    op: str
    inputs: tuple = ()
    table: str = ""
    cols: tuple = ()
    right_cols: tuple = ()
    pred: Pred | None = None

    def __post_init__(self):
        if self.op not in OPS:
            raise ValueError(f"unknown plan op {self.op!r}")

    def to_json(self):
        return {
            "op": self.op,
            "inputs": [p.to_json() for p in self.inputs],
            "table": self.table,
            "cols": list(self.cols),
            "right_cols": list(self.right_cols),
            "pred": self.pred.to_json() if self.pred is not None else None,
        }


def plan_from_json(data) -> Plan:
    return Plan(
        op=data["op"],
        inputs=tuple(plan_from_json(p) for p in data.get("inputs", [])),
        table=data.get("table", ""),
        cols=tuple(data.get("cols", ())),
        right_cols=tuple(data.get("right_cols", ())),
        pred=pred_from_json(data["pred"]) if data.get("pred") else None,
    )


# Convenience constructors -------------------------------------------------

def scan(table: str) -> Plan:
    return Plan("scan", table=table)


def filter_(inp: Plan, pred: Pred) -> Plan:
    return Plan("filter", inputs=(inp,), pred=pred)


def project(inp: Plan, cols) -> Plan:
    return Plan("project", inputs=(inp,), cols=tuple(cols))


def join(left: Plan, right: Plan, left_cols, right_cols) -> Plan:
    return Plan(
        "join",
        inputs=(left, right),
        cols=tuple(left_cols),
        right_cols=tuple(right_cols),
    )


def union_all(left: Plan, right: Plan) -> Plan:
    return Plan("union_all", inputs=(left, right))


def intersect_all(left: Plan, right: Plan) -> Plan:
    return Plan("intersect_all", inputs=(left, right))


def except_all(left: Plan, right: Plan) -> Plan:
    return Plan("except_all", inputs=(left, right))


def distinct(inp: Plan) -> Plan:
    return Plan("distinct", inputs=(inp,))
