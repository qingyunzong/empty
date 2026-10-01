"""Reference interpreter for peepbc bytecode.

DIV/MOD use truncating (C-style) semantics. ``run`` never raises for
program-level faults; it reports them as result categories instead.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .model import Program

MAX_STEPS = 10_000


def div_trunc(a: int, b: int) -> int:
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def mod_trunc(a: int, b: int) -> int:
    return a - div_trunc(a, b) * b


def _arith(op: str, a: int, b: int) -> int:
    if op == "ADD":
        return a + b
    if op == "SUB":
        return a - b
    if op == "MUL":
        return a * b
    if op == "DIV":
        return div_trunc(a, b)
    if op == "MOD":
        return mod_trunc(a, b)
    raise AssertionError(op)


@dataclass
class Result:
    category: str  # halt | divzero | underflow | bad_jump | bad_const | step_limit
    stack: list[int] = field(default_factory=list)
    steps: int = 0


def run(prog: Program, max_steps: int = MAX_STEPS) -> Result:
    stack: list[int] = []
    pc = 0
    steps = 0
    n = len(prog.code)
    while True:
        if pc == n:
            return Result("halt", stack, steps)  # falling off the end halts
        if pc < 0 or pc > n:
            return Result("bad_jump", stack, steps)
        if steps >= max_steps:
            return Result("step_limit", stack, steps)
        ins = prog.code[pc]
        steps += 1
        op = ins.op
        if op == "CONST":
            if not 0 <= ins.arg < len(prog.consts):
                return Result("bad_const", stack, steps)
            stack.append(prog.consts[ins.arg])
            pc += 1
        elif op in ("ADD", "SUB", "MUL", "DIV", "MOD"):
            if len(stack) < 2:
                return Result("underflow", stack, steps)
            b = stack.pop()
            a = stack.pop()
            if op in ("DIV", "MOD") and b == 0:
                return Result("divzero", stack, steps)
            stack.append(_arith(op, a, b))
            pc += 1
        elif op == "JMP":
            if not 0 <= ins.arg < n:
                return Result("bad_jump", stack, steps)
            pc = ins.arg
        elif op in ("JZ", "JNZ"):
            if not stack:
                return Result("underflow", stack, steps)
            v = stack.pop()
            taken = (v == 0) if op == "JZ" else (v != 0)
            if taken:
                if not 0 <= ins.arg < n:
                    return Result("bad_jump", stack, steps)
                pc = ins.arg
            else:
                pc += 1
        elif op == "HALT":
            return Result("halt", stack, steps)
        else:  # pragma: no cover - Instr validates opcodes
            raise AssertionError(op)
