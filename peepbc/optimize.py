"""Local (peephole) optimisations with an old_pc -> new_pc mapping.

Only semantics-preserving local rules are applied:

1. Constant folding: ``CONST a; CONST b; OP`` -> ``CONST (a OP b)``.
   DIV/MOD by a zero constant divisor are *never* folded, so the runtime
   ``div_zero`` fault is preserved.
2. Identities: ``CONST 0; ADD`` and ``CONST 1; MUL`` are removed.
   Only applied when the instruction immediately before the pair is a
   producer (CONST or a binary op), so a value is guaranteed to be on the
   stack; otherwise removing the pair would change the observable stack
   of a subsequent stack-underflow fault.
3. Jump-chain compression: a jump whose target is itself a JMP is
   retargeted to the end of the chain.
4. Dead-code elimination: instructions between an unconditional JMP or
   HALT and the next label (jump target) are removed.

Instructions that are jump targets are never removed or merged, so jumps
never land in the middle of a rewritten pattern.  Deleted instructions map
to the next executable point (or to ``len(code)`` if none follows).
"""

from __future__ import annotations

from . import isa
from .interp import trunc_div
from .program import Ins, Program


def _labels(code: list[Ins]) -> set[int]:
    return {ins.arg for ins in code if ins.op in isa.JUMPS and 0 <= ins.arg < len(code)}


def _remap_jumps(code: list[Ins], new: list[Ins], idx_map: list[int]) -> None:
    for j, ins in enumerate(new):
        if ins.op in isa.JUMPS:
            new[j] = Ins(ins.op, idx_map[ins.arg])


def _fold_pass(code: list[Ins], consts: list[int]):
    labels = _labels(code)
    const_index = {v: i for i, v in enumerate(consts)}
    n = len(code)
    idx_map = [0] * (n + 1)
    new: list[Ins] = []
    changed = False
    i = 0
    while i < n:
        if (
            i + 2 < n
            and code[i].op == isa.CONST
            and code[i + 1].op == isa.CONST
            and code[i + 2].op in isa.BINOPS
            and (i + 1) not in labels
            and (i + 2) not in labels
        ):
            a = consts[code[i].arg]
            b = consts[code[i + 1].arg]
            op = code[i + 2].op
            # Division/modulo by a zero constant must keep its runtime fault.
            if op in (isa.DIV, isa.MOD) and b == 0:
                pass
            else:
                if op == isa.ADD:
                    value = a + b
                elif op == isa.SUB:
                    value = a - b
                elif op == isa.MUL:
                    value = a * b
                elif op == isa.DIV:
                    value = trunc_div(a, b)
                else:  # MOD
                    value = a - trunc_div(a, b) * b
                ci = const_index.get(value)
                if ci is None:
                    ci = len(consts)
                    consts.append(value)
                    const_index[value] = ci
                idx_map[i] = idx_map[i + 1] = idx_map[i + 2] = len(new)
                new.append(Ins(isa.CONST, ci))
                i += 3
                changed = True
                continue
        idx_map[i] = len(new)
        new.append(code[i])
        i += 1
    idx_map[n] = len(new)
    if changed:
        _remap_jumps(code, new, idx_map)
    return new, idx_map, changed


def _identity_pass(code: list[Ins], consts: list[int]):
    labels = _labels(code)
    n = len(code)
    deleted: set[int] = set()
    i = 0
    while i + 1 < n:
        first, second = code[i], code[i + 1]
        if (
            first.op == isa.CONST
            and i > 0
            and code[i - 1].op in (isa.CONST, *isa.BINOPS)
            and i not in labels
            and (i + 1) not in labels
            and (
                (second.op == isa.ADD and consts[first.arg] == 0)
                or (second.op == isa.MUL and consts[first.arg] == 1)
            )
        ):
            deleted.add(i)
            deleted.add(i + 1)
            i += 2
        else:
            i += 1
    if not deleted:
        return code, list(range(n + 1)), False
    idx_map = [0] * (n + 1)
    new: list[Ins] = []
    for i, ins in enumerate(code):
        if i not in deleted:
            idx_map[i] = len(new)
            new.append(ins)
    idx_map[n] = len(new)
    for i in range(n - 1, -1, -1):
        if i in deleted:
            idx_map[i] = idx_map[i + 1]  # next executable point
    _remap_jumps(code, new, idx_map)
    return new, idx_map, True


def _jmp_chain_pass(code: list[Ins], consts: list[int]):
    n = len(code)
    new = list(code)
    changed = False
    for i, ins in enumerate(code):
        if ins.op not in isa.JUMPS or not 0 <= ins.arg < n:
            continue
        seen = {i}
        cur = ins.arg
        while cur not in seen and code[cur].op == isa.JMP and 0 <= code[cur].arg < n:
            seen.add(cur)
            cur = code[cur].arg
        if cur != ins.arg:
            new[i] = Ins(ins.op, cur)
            changed = True
    return new, list(range(n + 1)), changed


def _dead_code_pass(code: list[Ins], consts: list[int]):
    labels = _labels(code)
    n = len(code)
    deleted: set[int] = set()
    i = 0
    while i < n:
        if code[i].op in (isa.JMP, isa.HALT):
            j = i + 1
            while j < n and j not in labels:
                deleted.add(j)
                j += 1
            i = j
        else:
            i += 1
    if not deleted:
        return code, list(range(n + 1)), False
    idx_map = [0] * (n + 1)
    new: list[Ins] = []
    for i, ins in enumerate(code):
        if i not in deleted:
            idx_map[i] = len(new)
            new.append(ins)
    idx_map[n] = len(new)
    for i in range(n - 1, -1, -1):
        if i in deleted:
            idx_map[i] = idx_map[i + 1]  # next executable point
    _remap_jumps(code, new, idx_map)
    return new, idx_map, True


_PASSES = (_fold_pass, _identity_pass, _jmp_chain_pass, _dead_code_pass)


def optimize(prog: Program, max_rounds: int = 1000) -> tuple[Program, dict[int, int]]:
    """Optimise ``prog``; return ``(new_program, old_pc -> new_pc)``."""
    consts = list(prog.consts)
    code = list(prog.code)
    n0 = len(code)
    total = list(range(n0))  # original pc -> current pc (may be len(code))
    for _ in range(max_rounds):
        changed_any = False
        for pass_fn in _PASSES:
            code, idx_map, changed = pass_fn(code, consts)
            if changed:
                total = [idx_map[t] for t in total]
                changed_any = True
        if not changed_any:
            break
    mapping = {old_pc: total[old_pc] for old_pc in range(n0)}
    return Program(consts, code), mapping
