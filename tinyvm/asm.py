"""A tiny two-pass assembler for tinyvm bytecode.

Source format (one instruction per line, ``#`` starts a comment)::

    .consts 1 5        # constant pool values (ints)
    .locals 1          # number of locals per frame
    main:
      CONST 1          # operand: const-pool index / local index / label
      CALL fact
      HALT
    fact:
      STORE 0
      ...

Jump and call operands may be decimal addresses or label names.
Usable as a module: ``python -m tinyvm.asm prog.asm -o prog.bc``.
"""

from __future__ import annotations

import argparse
import sys

from . import isa
from .errors import VMError
from .program import Program


def assemble(source: str) -> Program:
    consts = []
    nlocals = 0
    statements = []  # (lineno, name, operand_text_or_None, label_or_None)
    labels = {}

    for lineno, raw in enumerate(source.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith(".consts"):
            consts = [int(tok) for tok in line.split()[1:]]
            continue
        if line.startswith(".locals"):
            nlocals = int(line.split()[1])
            continue
        label = None
        if ":" in line:
            label, line = (part.strip() for part in line.split(":", 1))
            if label in labels:
                raise VMError("duplicate label %r at line %d" % (label, lineno))
            labels[label] = None  # address filled in pass 1
            statements.append((lineno, None, None, label))
            if not line:
                continue
        parts = line.split()
        name = parts[0].upper()
        if name not in isa.OPCODES:
            raise VMError("unknown mnemonic %r at line %d" % (name, lineno))
        operand = parts[1] if len(parts) > 1 else None
        statements.append((lineno, name, operand, label))

    # Pass 1: assign addresses.
    pc = 0
    for lineno, name, operand, label in statements:
        if label is not None:
            labels[label] = pc
        if name is None:
            continue
        opcode = isa.OPCODES[name]
        has_operand = opcode in isa.OPERAND_OPS
        if has_operand and operand is None:
            raise VMError("%s needs an operand at line %d" % (name, lineno))
        if not has_operand and operand is not None:
            raise VMError("%s takes no operand at line %d" % (name, lineno))
        pc += isa.instruction_size(opcode)

    # Pass 2: emit code.
    code = bytearray()
    for lineno, name, operand, label in statements:
        if name is None:
            continue
        opcode = isa.OPCODES[name]
        code.append(opcode)
        if opcode in isa.OPERAND_OPS:
            if operand in labels:
                value = labels[operand]
            else:
                try:
                    value = int(operand)
                except ValueError:
                    raise VMError(
                        "undefined label %r at line %d" % (operand, lineno)
                    ) from None
            if not 0 <= value <= 0xFFFF:
                raise VMError(
                    "operand %d out of u16 range at line %d" % (value, lineno)
                )
            code.append(value & 0xFF)
            code.append((value >> 8) & 0xFF)

    return Program(consts=consts, nlocals=nlocals, code=bytes(code))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tinyvm.asm")
    parser.add_argument("source", help="assembly source file")
    parser.add_argument("-o", "--output", required=True, help="output .bc file")
    args = parser.parse_args(argv)
    try:
        with open(args.source, "r", encoding="utf-8") as handle:
            program = assemble(handle.read())
    except (OSError, VMError) as exc:
        print("tinyvm.asm: error: %s" % exc, file=sys.stderr)
        return 6
    with open(args.output, "wb") as handle:
        handle.write(program.serialize())
    return 0


if __name__ == "__main__":
    sys.exit(main())
