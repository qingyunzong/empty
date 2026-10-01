"""Bytecode model and text (de)serialization for peepbc.

G3-style stack machine bytecode. Text format::

    # peepbc v1
    consts:
    0: 10
    1: -3
    code:
    0: CONST 0
    1: CONST 1
    2: ADD
    3: HALT
    map:
    0: 0
    1: 1
    2: 2
    3: 3

The ``map`` section is optional and ignored when parsing.
"""
from __future__ import annotations

from dataclasses import dataclass, field

OPS_NOARG = frozenset({"ADD", "SUB", "MUL", "DIV", "MOD", "HALT"})
OPS_ARG = frozenset({"CONST", "JMP", "JZ", "JNZ"})
OPS = OPS_NOARG | OPS_ARG
ARITH = frozenset({"ADD", "SUB", "MUL", "DIV", "MOD"})
JUMPS = frozenset({"JMP", "JZ", "JNZ"})


class ParseError(Exception):
    """Raised when a .bc file cannot be parsed."""


@dataclass
class Instr:
    op: str
    arg: int | None = None

    def __post_init__(self) -> None:
        if self.op not in OPS:
            raise ValueError(f"unknown opcode: {self.op!r}")
        if self.op in OPS_ARG and self.arg is None:
            raise ValueError(f"{self.op} requires an argument")
        if self.op in OPS_NOARG and self.arg is not None:
            raise ValueError(f"{self.op} takes no argument")


@dataclass
class Program:
    consts: list[int] = field(default_factory=list)
    code: list[Instr] = field(default_factory=list)


def _strip_comment(line: str) -> str:
    return line.split("#", 1)[0].strip()


def parse(text: str) -> Program:
    consts: list[int] = []
    code: list[Instr] = []
    section = None
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = _strip_comment(raw)
        if not line:
            continue
        if line.endswith(":") and line[:-1] in ("consts", "code", "map"):
            section = line[:-1]
            continue
        if section is None:
            raise ParseError(f"line {lineno}: entry before any section")
        # tolerate an optional "idx:" prefix
        body = line
        head, sep, rest = line.partition(":")
        if sep and head.strip().lstrip("-").isdigit():
            body = rest.strip()
        if section == "map":
            continue  # mapping metadata is output-only
        if section == "consts":
            try:
                consts.append(int(body))
            except ValueError:
                raise ParseError(f"line {lineno}: bad constant {body!r}") from None
        else:  # code
            parts = body.split()
            op = parts[0].upper()
            try:
                if op in OPS_NOARG and len(parts) == 1:
                    code.append(Instr(op))
                elif op in OPS_ARG and len(parts) == 2:
                    code.append(Instr(op, int(parts[1])))
                else:
                    raise ParseError(f"line {lineno}: bad instruction {body!r}")
            except ValueError as exc:
                raise ParseError(f"line {lineno}: {exc}") from None
    return Program(consts, code)


def dump(prog: Program, mapping: dict[int, int] | None = None) -> str:
    out = ["# peepbc v1", "consts:"]
    out += [f"{i}: {c}" for i, c in enumerate(prog.consts)]
    out.append("code:")
    for i, ins in enumerate(prog.code):
        if ins.arg is None:
            out.append(f"{i}: {ins.op}")
        else:
            out.append(f"{i}: {ins.op} {ins.arg}")
    if mapping is not None:
        out.append("map:")
        out += [f"{old}: {new}" for old, new in sorted(mapping.items())]
    return "\n".join(out) + "\n"
