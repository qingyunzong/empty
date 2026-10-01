"""Instruction set definition for tinyvm.

Encoding: each instruction is 1 opcode byte, optionally followed by a
little-endian uint16 operand. Instructions with an operand are 3 bytes,
all others are 1 byte. Jump/branch operands are absolute byte offsets
into the code section.
"""

OPCODES = {
    "CONST": 0x01,
    "LOAD": 0x02,
    "STORE": 0x03,
    "ADD": 0x10,
    "SUB": 0x11,
    "MUL": 0x12,
    "DIV": 0x13,
    "MOD": 0x14,
    "JMP": 0x20,
    "JZ": 0x21,
    "JNZ": 0x22,
    "CALL": 0x30,
    "RET": 0x31,
    "HALT": 0x3F,
}

NAMES = {code: name for name, code in OPCODES.items()}

# Opcodes carrying a uint16 operand.
OPERAND_OPS = frozenset(
    OPCODES[name] for name in ("CONST", "LOAD", "STORE", "JMP", "JZ", "JNZ", "CALL")
)

# Opcodes whose operand is a code address (validated against boundaries).
JUMP_OPS = frozenset(OPCODES[name] for name in ("JMP", "JZ", "JNZ", "CALL"))


def instruction_size(opcode):
    return 3 if opcode in OPERAND_OPS else 1


def decode(code, pc):
    """Decode the instruction at ``pc``.

    Returns ``(opcode, operand, size)``; ``operand`` is None for
    operand-less instructions. Raises IndexError/struct.error on
    truncated input; callers validate bounds beforehand.
    """
    opcode = code[pc]
    if opcode in OPERAND_OPS:
        operand = code[pc + 1] | (code[pc + 2] << 8)
        return opcode, operand, 3
    return opcode, None, 1
