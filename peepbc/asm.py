"""Tiny text assembler, handy for hand-writing test programs.

Syntax::

    CONST 5        ; integer literal, added to the constant pool
    ADD
    JMP loop       ; numeric targets also accepted
    loop: HALT
"""

from __future__ import annotations

from . import isa
from .program import Ins, Program


def assemble(text: str) -> Program:
    consts: list[int] = []
    const_index: dict[int, int] = {}
    labels: dict[str, int] = {}
    parsed: list[tuple[str, str | None]] = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].split(";", 1)[0].strip()
        if not line:
            continue
        while True:
            head, sep, rest = line.partition(":")
            if sep and head.strip().isidentifier():
                labels[head.strip()] = len(parsed)
                line = rest.strip()
            else:
                break
        if not line:
            continue
        parts = line.split()
        op_name = parts[0].upper()
        if op_name not in isa.BY_NAME:
            raise ValueError(f"line {lineno}: unknown opcode {parts[0]!r}")
        parsed.append((op_name, parts[1] if len(parts) > 1 else None))
    code: list[Ins] = []
    for op_name, operand in parsed:
        op = isa.BY_NAME[op_name]
        if op == isa.CONST:
            if operand is None:
                raise ValueError("CONST needs an integer operand")
            value = int(operand, 0)
            ci = const_index.get(value)
            if ci is None:
                ci = len(consts)
                consts.append(value)
                const_index[value] = ci
            code.append(Ins(op, ci))
        elif op in isa.JUMPS:
            if operand is None:
                raise ValueError(f"{op_name} needs a target")
            target = labels[operand] if operand in labels else int(operand, 0)
            code.append(Ins(op, target))
        else:
            code.append(Ins(op, 0))
    return Program(consts, code)
