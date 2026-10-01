"""Post-rewrite verification.

Checks, on the *rewritten* program:

* every jump target is inside the code section (instruction boundary);
* every CONST operand is a valid constant-pool index;
* the stack depth on *any* execution path stays within [0, max_stack]
  (exact min/max abstract interpretation over the control-flow graph;
  loops with a positive net stack effect are caught because the recorded
  maximum keeps growing until it exceeds the limit).
"""

from __future__ import annotations

from collections import deque

from . import isa
from .program import Program


def verify(prog: Program, max_stack: int = isa.MAX_STACK) -> list[str]:
    errors: list[str] = []
    n = len(prog.code)
    for pc, ins in enumerate(prog.code):
        if ins.op == isa.CONST and not 0 <= ins.arg < len(prog.consts):
            errors.append(f"pc {pc}: CONST index {ins.arg} out of range "
                          f"({len(prog.consts)} consts)")
        if ins.op in isa.JUMPS and not 0 <= ins.arg < n:
            errors.append(f"pc {pc}: jump target {ins.arg} out of bounds "
                          f"({n} instructions)")
    if errors:
        return errors

    lo: list[int | None] = [None] * n
    hi: list[int | None] = [None] * n
    if n == 0:
        return errors
    lo[0] = hi[0] = 0
    work = deque([0])
    while work:
        pc = work.popleft()
        ins = prog.code[pc]
        if ins.op == isa.CONST:
            delta = 1
        elif ins.op in isa.BINOPS or ins.op in (isa.JZ, isa.JNZ):
            delta = -1
        else:
            delta = 0
        new_lo = lo[pc] + delta
        new_hi = hi[pc] + delta
        if new_lo < 0:
            errors.append(f"pc {pc}: stack underflow on some path")
            continue
        if new_hi > max_stack:
            errors.append(f"pc {pc}: stack depth may exceed {max_stack}")
            continue
        if ins.op == isa.JMP:
            succs = [ins.arg]
        elif ins.op in (isa.JZ, isa.JNZ):
            succs = [ins.arg, pc + 1]
        elif ins.op == isa.HALT:
            succs = []
        else:
            succs = [pc + 1]
        for s in succs:
            if s >= n:
                continue  # falling off the end is an implicit halt
            if lo[s] is None or new_lo < lo[s] or new_hi > hi[s]:
                lo[s] = new_lo if lo[s] is None else min(lo[s], new_lo)
                hi[s] = new_hi if hi[s] is None else max(hi[s], new_hi)
                work.append(s)
    return errors
