"""Instruction set and text parser for typedbc bytecode (.tbc files)."""

from dataclasses import dataclass

from .errors import VerifyError

INT = "int"
BOOL = "bool"
TYPES = (INT, BOOL)

OPS = ("CONST_INT", "CONST_BOOL", "ADD", "CMP", "NOT", "JZ", "JMP", "HALT")
JUMP_OPS = ("JZ", "JMP")


@dataclass(frozen=True)
class Instruction:
    op: str
    arg: object
    pc: int


def _parse_bool(token, lineno):
    low = token.lower()
    if low in ("true", "1"):
        return True
    if low in ("false", "0"):
        return False
    raise VerifyError("line %d: bad CONST_BOOL operand %r" % (lineno, token))


def parse(text):
    """Parse .tbc source text into a list of Instructions.

    One instruction per line; blank lines and '#' comments are ignored.
    Syntax errors raise VerifyError (a structural error).
    """
    prog = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        op = parts[0].upper()
        pc = len(prog)
        if op not in OPS:
            raise VerifyError(
                "line %d: unknown opcode %r" % (lineno, parts[0]), pc=pc
            )
        if op == "CONST_INT":
            if len(parts) != 2:
                raise VerifyError("line %d: CONST_INT needs one operand" % lineno, pc=pc)
            try:
                arg = int(parts[1], 10)
            except ValueError:
                raise VerifyError(
                    "line %d: bad CONST_INT operand %r" % (lineno, parts[1]), pc=pc
                ) from None
        elif op == "CONST_BOOL":
            if len(parts) != 2:
                raise VerifyError("line %d: CONST_BOOL needs one operand" % lineno, pc=pc)
            arg = _parse_bool(parts[1], lineno)
        elif op in JUMP_OPS:
            if len(parts) != 2:
                raise VerifyError("line %d: %s needs a target" % (lineno, op), pc=pc)
            try:
                arg = int(parts[1], 10)
            except ValueError:
                raise VerifyError(
                    "line %d: bad %s target %r" % (lineno, op, parts[1]), pc=pc
                ) from None
        else:
            if len(parts) != 1:
                raise VerifyError("line %d: %s takes no operand" % (lineno, op), pc=pc)
            arg = None
        prog.append(Instruction(op=op, arg=arg, pc=pc))
    return prog
