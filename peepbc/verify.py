"""Post-rewrite verification.

Checks, on the rewritten program:
  * every jump target is inside the code;
  * every CONST index is inside the constant pool;
  * the operand stack depth never exceeds ``max_depth`` on any path
    (exact exploration of the finite (pc, depth) state space).
"""
from __future__ import annotations

from collections import deque

from .model import ARITH, Program

MAX_DEPTH = 256
_DEPTH_FLOOR = -8192  # prune only to keep the state space finite


def verify(prog: Program, max_depth: int = MAX_DEPTH) -> list[str]:
    errors: list[str] = []
    n = len(prog.code)
    for pc, ins in enumerate(prog.code):
        if ins.op == "CONST" and not 0 <= ins.arg < len(prog.consts):
            errors.append(f"pc {pc}: CONST index {ins.arg} out of range")
        if ins.op in ("JMP", "JZ", "JNZ") and not 0 <= ins.arg < n:
            errors.append(f"pc {pc}: jump target {ins.arg} out of range")
    if errors:
        return errors

    seen: set[tuple[int, int]] = set()
    queue: deque[tuple[int, int]] = deque([(0, 0)])
    while queue:
        pc, depth = queue.popleft()
        if depth > max_depth:
            errors.append(
                f"stack depth {depth} exceeds limit {max_depth} at pc {pc}"
            )
            return errors
        if pc >= n or depth < _DEPTH_FLOOR:
            continue
        if (pc, depth) in seen:
            continue
        seen.add((pc, depth))
        ins = prog.code[pc]
        op = ins.op
        if op == "HALT":
            continue
        if op == "CONST":
            queue.append((pc + 1, depth + 1))
        elif op in ARITH:
            queue.append((pc + 1, depth - 1))
        elif op == "JMP":
            queue.append((ins.arg, depth))
        elif op in ("JZ", "JNZ"):
            queue.append((ins.arg, depth - 1))
            queue.append((pc + 1, depth - 1))
    return errors
