"""Reference interpreter for peepbc programs.

Observable behaviour is defined by the returned :class:`Result`:
the final ``status`` (error category) and the final ``stack``.
DIV/MOD use truncating (C-style) division; a zero divisor is a runtime
fault with status ``"div_zero"``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import isa
from .program import Program


@dataclass
class Result:
    status: str  # halt | div_zero | stack_overflow | stack_underflow |
                 # bad_jump | bad_const | bad_opcode | step_limit
    stack: list[int] = field(default_factory=list)
    steps: int = 0


def trunc_div(a: int, b: int) -> int:
    """Integer division truncating toward zero (b must be non-zero)."""
    q = abs(a) // abs(b)
    return -q if (a < 0) != (b < 0) else q


def run(prog: Program, max_steps: int = 100_000, max_stack: int = isa.MAX_STACK) -> Result:
    stack: list[int] = []
    code = prog.code
    n = len(code)
    pc = 0
    steps = 0
    while 0 <= pc < n:
        if steps >= max_steps:
            return Result("step_limit", list(stack), steps)
        ins = code[pc]
        steps += 1
        op = ins.op
        if op == isa.CONST:
            if not 0 <= ins.arg < len(prog.consts):
                return Result("bad_const", list(stack), steps)
            stack.append(prog.consts[ins.arg])
            if len(stack) > max_stack:
                return Result("stack_overflow", list(stack), steps)
            pc += 1
        elif op in isa.BINOPS:
            if len(stack) < 2:
                return Result("stack_underflow", list(stack), steps)
            b = stack.pop()
            a = stack.pop()
            if op == isa.ADD:
                stack.append(a + b)
            elif op == isa.SUB:
                stack.append(a - b)
            elif op == isa.MUL:
                stack.append(a * b)
            else:  # DIV or MOD
                if b == 0:
                    return Result("div_zero", list(stack), steps)
                q = trunc_div(a, b)
                stack.append(q if op == isa.DIV else a - q * b)
            pc += 1
        elif op == isa.JMP:
            if not 0 <= ins.arg < n:
                return Result("bad_jump", list(stack), steps)
            pc = ins.arg
        elif op in (isa.JZ, isa.JNZ):
            if not stack:
                return Result("stack_underflow", list(stack), steps)
            v = stack.pop()
            take = (v == 0) if op == isa.JZ else (v != 0)
            if take:
                if not 0 <= ins.arg < n:
                    return Result("bad_jump", list(stack), steps)
                pc = ins.arg
            else:
                pc += 1
        elif op == isa.HALT:
            return Result("halt", list(stack), steps)
        else:
            return Result("bad_opcode", list(stack), steps)
    # Falling off the end of the code is an implicit halt.
    return Result("halt", list(stack), steps)
