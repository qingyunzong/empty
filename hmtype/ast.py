"""AST nodes for the mini language. Every node carries a source Span."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class Span:
    line: int
    col: int
    end_line: int
    end_col: int

    def to_json(self) -> dict:
        return {
            "line": self.line,
            "col": self.col,
            "end_line": self.end_line,
            "end_col": self.end_col,
        }


class Node:
    span: Span


@dataclass(frozen=True)
class IntLit(Node):
    value: int
    span: Span


@dataclass(frozen=True)
class BoolLit(Node):
    value: bool
    span: Span


@dataclass(frozen=True)
class Var(Node):
    name: str
    span: Span


@dataclass(frozen=True)
class Lam(Node):
    param: str
    body: Node
    span: Span


@dataclass(frozen=True)
class App(Node):
    func: Node
    arg: Node
    span: Span


@dataclass(frozen=True)
class Let(Node):
    name: str
    value: Node
    body: Node
    span: Span


@dataclass(frozen=True)
class If(Node):
    cond: Node
    then: Node
    els: Node
    span: Span


@dataclass(frozen=True)
class Fix(Node):
    param: str
    body: Node
    span: Span


@dataclass(frozen=True)
class BinOp(Node):
    op: str
    left: Node
    right: Node
    span: Span


@dataclass(frozen=True)
class TupleLit(Node):
    elems: Tuple[Node, ...]
    span: Span
