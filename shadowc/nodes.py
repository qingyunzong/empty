"""AST node definitions for the shadowc policy DSL."""

from __future__ import annotations

from dataclasses import dataclass, field as _field
from typing import Optional, Union


@dataclass
class FieldType:
    kind: str  # "int" | "string" | "enum"
    domain: Optional[tuple] = None  # enum domain, in declaration order


@dataclass
class FieldDecl:
    name: str
    ftype: FieldType
    line: int
    col: int


@dataclass
class Rule:
    name: str
    cond: "Cond"
    actions: list
    line: int
    col: int


@dataclass
class Policy:
    fields: list = _field(default_factory=list)
    actions: list = _field(default_factory=list)
    rules: list = _field(default_factory=list)


# --- condition nodes (resolved & type-checked) ---


@dataclass
class Or:
    left: "Cond"
    right: "Cond"


@dataclass
class And:
    left: "Cond"
    right: "Cond"


@dataclass
class Not:
    operand: "Cond"


@dataclass
class Interval:
    field: str
    lo: int
    hi: int
    line: int
    col: int


@dataclass
class IntValues:
    field: str
    values: frozenset
    line: int
    col: int


@dataclass
class StrPatterns:
    # patterns: tuple of (text, is_prefix)
    field: str
    patterns: tuple
    line: int
    col: int


@dataclass
class EnumValues:
    field: str
    values: frozenset
    line: int
    col: int


Cond = Union[Or, And, Not, Interval, IntValues, StrPatterns, EnumValues]
