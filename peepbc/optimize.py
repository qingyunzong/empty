"""Safe local peephole rewriting.

Rules (all local, all semantics-preserving including fault behaviour):

1. Constant folding: ``CONST a; CONST b; OP`` -> ``CONST (a OP b)``.
   Never folded when OP is DIV/MOD and b == 0: the runtime divzero
   fault must be preserved.  Not applied across jump targets (labels).
2. Identities: ``CONST 0; ADD`` and ``CONST 1; MUL`` are removed, but
   only when the preceding instruction statically guarantees a
   non-empty stack (otherwise removing them could hide an underflow
   fault) and neither instruction is a jump target.
3. Jump-chain compression: jumps to a JMP are retargeted to the end of
   the JMP chain (cycle-safe).
4. Dead code elimination: instructions after an unconditional JMP or
   HALT are removed up to the next label.

Every pass preserves instruction order and records, for each emitted
instruction, the original pc it stems from.  ``optimize`` returns the
rewritten program plus a mapping old_pc -> new_pc; deleted instructions
map to the next executable point (or len(code) if none remains).
"""
from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, replace

from .interp import div_trunc, mod_trunc
from .model import ARITH, JUMPS, Instr, Program

_DEPTH_OK_PREV = ARITH | {"CONST"}
_MAX_PASSES = 100


@dataclass
class _Ins:
    op: str
    arg: int | None
    origin: int  # pc in the *original* program


def _labels(code: list[_Ins]) -> set[int]:
    return {ins.arg for ins in code if ins.op in JUMPS}


def _remap(emitted: list[tuple[int, _Ins]]) -> list[_Ins]:
    """Fix jump args after a pass; emitted holds (src_index, instr)."""
    srcs = [src for src, _ in emitted]
    n = len(emitted)
    out: list[_Ins] = []
    for _, ins in emitted:
        if ins.op in JUMPS:
            j = bisect_left(srcs, ins.arg)
            ins = replace(ins, arg=j if j < n else n)
        out.append(ins)
    return out


def _fold_value(op: str, a: int, b: int) -> int:
    if op == "ADD":
        return a + b
    if op == "SUB":
        return a - b
    if op == "MUL":
        return a * b
    if op == "DIV":
        return div_trunc(a, b)
    return mod_trunc(a, b)


def _fold_pass(code: list[_Ins], consts: list[int]) -> tuple[list[_Ins], bool]:
    labels = _labels(code)
    emitted: list[tuple[int, _Ins]] = []
    changed = False

    def const_index(value: int) -> int:
        try:
            return consts.index(value)
        except ValueError:
            consts.append(value)
            return len(consts) - 1

    i = 0
    n = len(code)
    while i < n:
        cur = code[i]
        # Rule 1: constant folding.
        if (
            cur.op == "CONST"
            and i + 2 < n
            and code[i + 1].op == "CONST"
            and code[i + 2].op in ARITH
            and (i + 1) not in labels
            and (i + 2) not in labels
        ):
            a = consts[cur.arg]
            b = consts[code[i + 1].arg]
            op = code[i + 2].op
            # Rule 3 of the spec: never fold a divzero fault away.
            if not (op in ("DIV", "MOD") and b == 0):
                folded = _Ins("CONST", const_index(_fold_value(op, a, b)), cur.origin)
                emitted.append((i, folded))
                i += 3
                changed = True
                continue
        # Rule 2: identities x+0 and x*1.
        if cur.op == "CONST" and i + 1 < n:
            nxt = code[i + 1]
            value = consts[cur.arg]
            is_identity = (value == 0 and nxt.op == "ADD") or (
                value == 1 and nxt.op == "MUL"
            )
            prev_ok = bool(emitted) and emitted[-1][1].op in _DEPTH_OK_PREV
            if (
                is_identity
                and i not in labels
                and (i + 1) not in labels
                and prev_ok
            ):
                i += 2
                changed = True
                continue
        emitted.append((i, replace(cur)))
        i += 1
    return _remap(emitted), changed


def _dce_pass(code: list[_Ins]) -> tuple[list[_Ins], bool]:
    labels = _labels(code)
    emitted: list[tuple[int, _Ins]] = []
    dead = False
    changed = False
    for idx, ins in enumerate(code):
        if idx in labels:
            dead = False
        if dead:
            changed = True
            continue
        emitted.append((idx, replace(ins)))
        if ins.op in ("JMP", "HALT"):
            dead = True
    return _remap(emitted), changed


def _chain_pass(code: list[_Ins]) -> tuple[list[_Ins], bool]:
    n = len(code)
    emitted: list[tuple[int, _Ins]] = []
    changed = False
    for idx, ins in enumerate(code):
        if ins.op in JUMPS:
            t = ins.arg
            seen = {idx}
            while 0 <= t < n and code[t].op == "JMP" and t not in seen:
                seen.add(t)
                t = code[t].arg
            if t != ins.arg:
                ins = replace(ins, arg=t)
                changed = True
        emitted.append((idx, ins))
    return _remap(emitted), changed


def optimize(prog: Program) -> tuple[Program, dict[int, int]]:
    """Optimize ``prog``; return (new_program, old_pc -> new_pc)."""
    consts = list(prog.consts)
    code = [_Ins(ins.op, ins.arg, origin=i) for i, ins in enumerate(prog.code)]
    for _ in range(_MAX_PASSES):
        changed = False
        code, c = _fold_pass(code, consts)
        changed |= c
        code, c = _dce_pass(code)
        changed |= c
        code, c = _chain_pass(code)
        changed |= c
        if not changed:
            break
    origins = [ins.origin for ins in code]
    n = len(code)
    mapping: dict[int, int] = {}
    for old_pc in range(len(prog.code)):
        j = bisect_left(origins, old_pc)
        mapping[old_pc] = j if j < n else n
    new_prog = Program(consts, [Instr(ins.op, ins.arg) for ins in code])
    return new_prog, mapping
