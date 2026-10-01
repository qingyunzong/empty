"""Instruction model and text parser for typedbc bytecode."""

from __future__ import annotations

from dataclasses import dataclass


class VerificationFailure(Exception):
    """Base class for all verification failures (CLI exit code 12)."""

    exit_code = 12


class VerifyError(VerificationFailure):
    """Structural error: bad jump target, stack underflow, stack overflow."""


class JoinError(VerificationFailure):
    """Type stacks at a CFG join point differ in height or element types."""

    def __init__(self, pc: int, expected: tuple[str, ...], actual: tuple[str, ...]):
        self.pc = pc
        self.expected = tuple(expected)
        self.actual = tuple(actual)
        super().__init__(
            f"JoinError at pc {pc}: stack {list(self.actual)} does not match "
            f"expected {list(self.expected)}"
        )


class TypeFault(VerificationFailure):
    """Operand type mismatch at a reachable instruction."""

    def __init__(self, pc: int, expected: str, actual: str, stack: list[str]):
        self.pc = pc
        self.expected = expected
        self.actual = actual
        self.stack = list(stack)
        super().__init__(
            f"TypeFault at pc {pc}: expected {expected}, got {actual} "
            f"(stack={self.stack})"
        )


OPS_NO_ARG = ("ADD", "CMP", "NOT", "HALT")
OPS_INT_ARG = ("CONST_INT", "JZ", "JMP")
OPS_BOOL_ARG = ("CONST_BOOL",)
OPS = OPS_NO_ARG + OPS_INT_ARG + OPS_BOOL_ARG


@dataclass(frozen=True)
class Instruction:
    op: str
    arg: int | bool | None
    pc: int

    def __str__(self) -> str:
        if self.arg is None:
            return self.op
        if isinstance(self.arg, bool):
            return f"{self.op} {'true' if self.arg else 'false'}"
        return f"{self.op} {self.arg}"


def parse(text: str) -> list[Instruction]:
    """Parse assembly text into an instruction list.

    Raises VerifyError on malformed lines (structural error).
    """
    program: list[Instruction] = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        op = parts[0].upper()
        pc = len(program)
        if op in OPS_NO_ARG:
            if len(parts) != 1:
                raise VerifyError(f"line {lineno}: {op} takes no operand")
            program.append(Instruction(op, None, pc))
        elif op in OPS_INT_ARG:
            if len(parts) != 2:
                raise VerifyError(f"line {lineno}: {op} needs one integer operand")
            try:
                arg = int(parts[1], 10)
            except ValueError:
                raise VerifyError(
                    f"line {lineno}: bad integer operand {parts[1]!r}"
                ) from None
            if op in ("JZ", "JMP") and arg < 0:
                raise VerifyError(f"line {lineno}: negative jump target {arg}")
            program.append(Instruction(op, arg, pc))
        elif op in OPS_BOOL_ARG:
            if len(parts) != 2 or parts[1].lower() not in ("true", "false"):
                raise VerifyError(
                    f"line {lineno}: CONST_BOOL needs operand true/false"
                )
            program.append(Instruction(op, parts[1].lower() == "true", pc))
        else:
            raise VerifyError(f"line {lineno}: unknown opcode {parts[0]!r}")
    if not program:
        raise VerifyError("empty program")
    return program
