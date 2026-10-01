"""Forward abstract interpretation over basic blocks with exact type stacks."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .model import (
    Instruction,
    JoinError,
    TypeFault,
    VerifyError,
)

INT = "int"
BOOL = "bool"
MAX_STACK = 32


@dataclass
class DeadTypeWarning:
    """A type-level problem inside unreachable code (warning only)."""

    pc: int
    message: str
    expected: str = ""
    actual: str = ""
    stack: list[str] = field(default_factory=list)
    kind: str = "DeadType"


@dataclass
class BlockInfo:
    index: int
    start: int
    end: int  # exclusive
    reachable: bool
    entry_stack: list[str] | None
    exit_stack: list[str] | None
    successors: list[int]  # block indices


@dataclass
class Report:
    blocks: list[BlockInfo]
    warnings: list[DeadTypeWarning]

    def to_dict(self) -> dict:
        return {
            "status": "ok",
            "blocks": [
                {
                    "index": b.index,
                    "start": b.start,
                    "end": b.end,
                    "reachable": b.reachable,
                    "entry_stack": b.entry_stack,
                    "exit_stack": b.exit_stack,
                    "successors": b.successors,
                }
                for b in self.blocks
            ],
            "warnings": [
                {
                    "kind": w.kind,
                    "pc": w.pc,
                    "message": w.message,
                    "expected": w.expected,
                    "actual": w.actual,
                    "stack": w.stack,
                }
                for w in self.warnings
            ],
        }


def _check_structure(program: list[Instruction]) -> None:
    n = len(program)
    for ins in program:
        if ins.op in ("JZ", "JMP") and not (0 <= ins.arg < n):
            raise VerifyError(
                f"pc {ins.pc}: jump target {ins.arg} out of range [0, {n})"
            )
    last = program[-1]
    if last.op not in ("JMP", "HALT"):
        raise VerifyError(
            f"pc {last.pc}: control falls off the end of the program"
        )


def _find_leaders(program: list[Instruction]) -> list[int]:
    n = len(program)
    leaders = {0}
    for i, ins in enumerate(program):
        if ins.op in ("JZ", "JMP"):
            leaders.add(ins.arg)
            if i + 1 < n:
                leaders.add(i + 1)
        elif ins.op == "HALT" and i + 1 < n:
            leaders.add(i + 1)
    return sorted(leaders)


def _pop(stack: list[str], pc: int, expected: str) -> str:
    if not stack:
        raise VerifyError(f"pc {pc}: stack underflow")
    actual = stack.pop()
    if actual != expected:
        raise TypeFault(pc, expected, actual, stack + [actual])
    return actual


def _simulate(
    program: list[Instruction],
    start: int,
    end: int,
    entry: tuple[str, ...],
    block_of: list[int],
) -> tuple[tuple[str, ...], list[int]]:
    """Run one reachable block. Returns (exit stack, successor block indices)."""
    stack = list(entry)
    for pc in range(start, end):
        ins = program[pc]
        op = ins.op
        if op == "CONST_INT":
            stack.append(INT)
        elif op == "CONST_BOOL":
            stack.append(BOOL)
        elif op == "ADD":
            _pop(stack, pc, INT)
            _pop(stack, pc, INT)
            stack.append(INT)
        elif op == "CMP":
            _pop(stack, pc, INT)
            _pop(stack, pc, INT)
            stack.append(BOOL)
        elif op == "NOT":
            _pop(stack, pc, BOOL)
            stack.append(BOOL)
        elif op == "JZ":
            _pop(stack, pc, BOOL)
        elif op in ("JMP", "HALT"):
            pass
        else:  # pragma: no cover - parser rejects unknown ops
            raise VerifyError(f"pc {pc}: unknown opcode {op!r}")
        if len(stack) > MAX_STACK:
            raise VerifyError(
                f"pc {pc}: stack height {len(stack)} exceeds limit {MAX_STACK}"
            )
    # Successors are determined by the block's terminating instruction
    # (blocks are maximal, so a terminator can only appear last).
    last = program[end - 1]
    if last.op == "JZ":
        succs = [block_of[last.arg], block_of[end]]
    elif last.op == "JMP":
        succs = [block_of[last.arg]]
    elif last.op == "HALT":
        succs = []
    else:
        succs = [block_of[end]]
    return tuple(stack), succs


def _simulate_dead(
    program: list[Instruction],
    start: int,
    end: int,
    warnings: list[DeadTypeWarning],
) -> None:
    """Lenient pass over an unreachable block: type problems become warnings."""
    stack: list[str | None] = []  # None = unknown (recovered from an earlier fault)
    for pc in range(start, end):
        ins = program[pc]
        op = ins.op

        def pop(expected: str) -> None:
            if not stack:
                warnings.append(
                    DeadTypeWarning(pc, f"stack underflow in dead code at pc {pc}")
                )
                return
            actual = stack.pop()
            if actual is not None and actual != expected:
                warnings.append(
                    DeadTypeWarning(
                        pc,
                        f"type fault in dead code at pc {pc}: "
                        f"expected {expected}, got {actual}",
                        expected=expected,
                        actual=actual,
                        stack=[t or "?" for t in stack] + [actual],
                    )
                )

        if op == "CONST_INT":
            stack.append(INT)
        elif op == "CONST_BOOL":
            stack.append(BOOL)
        elif op == "ADD":
            pop(INT)
            pop(INT)
            stack.append(INT)
        elif op == "CMP":
            pop(INT)
            pop(INT)
            stack.append(BOOL)
        elif op == "NOT":
            pop(BOOL)
            stack.append(BOOL)
        elif op == "JZ":
            pop(BOOL)
        if len(stack) > MAX_STACK:
            warnings.append(
                DeadTypeWarning(
                    pc, f"stack height exceeds {MAX_STACK} in dead code at pc {pc}"
                )
            )
            return


def verify(program: list[Instruction]) -> Report:
    """Verify a parsed program. Raises VerificationFailure on error."""
    _check_structure(program)
    n = len(program)
    leaders = _find_leaders(program)
    spans = [
        (leaders[i], leaders[i + 1] if i + 1 < len(leaders) else n)
        for i in range(len(leaders))
    ]
    block_of = [0] * n
    for idx, (s, e) in enumerate(spans):
        for pc in range(s, e):
            block_of[pc] = idx

    entry_state: dict[int, tuple[str, ...]] = {0: ()}
    exit_state: dict[int, tuple[str, ...]] = {}
    block_succs: dict[int, list[int]] = {}
    worklist: deque[int] = deque([0])
    while worklist:
        b = worklist.popleft()
        s, e = spans[b]
        exit_stack, succs = _simulate(program, s, e, entry_state[b], block_of)
        exit_state[b] = exit_stack
        block_succs[b] = succs
        for nxt in succs:
            if nxt in entry_state:
                if entry_state[nxt] != exit_stack:
                    raise JoinError(spans[nxt][0], entry_state[nxt], exit_stack)
            else:
                entry_state[nxt] = exit_stack
                worklist.append(nxt)

    warnings: list[DeadTypeWarning] = []
    blocks: list[BlockInfo] = []
    for idx, (s, e) in enumerate(spans):
        reachable = idx in entry_state
        if not reachable:
            _simulate_dead(program, s, e, warnings)
        blocks.append(
            BlockInfo(
                index=idx,
                start=s,
                end=e,
                reachable=reachable,
                entry_stack=list(entry_state[idx]) if reachable else None,
                exit_stack=list(exit_state[idx]) if reachable else None,
                successors=block_succs.get(idx, []),
            )
        )
    return Report(blocks=blocks, warnings=warnings)
