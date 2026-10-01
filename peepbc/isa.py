"""Instruction set for the peepbc bytecode.

A small G3-style stack-machine instruction set, implemented independently.
Each instruction is a fixed 3-byte record: 1 opcode byte + 2 operand bytes
(little-endian unsigned 16-bit).  Instructions without an operand store 0.
"""

CONST = 0x01
ADD = 0x02
SUB = 0x03
MUL = 0x04
DIV = 0x05
MOD = 0x06
JMP = 0x07
JZ = 0x08
JNZ = 0x09
HALT = 0x0A

NAMES = {
    CONST: "CONST",
    ADD: "ADD",
    SUB: "SUB",
    MUL: "MUL",
    DIV: "DIV",
    MOD: "MOD",
    JMP: "JMP",
    JZ: "JZ",
    JNZ: "JNZ",
    HALT: "HALT",
}
BY_NAME = {name: op for op, name in NAMES.items()}

#: Opcodes that carry a 16-bit operand.
HAS_ARG = frozenset({CONST, JMP, JZ, JNZ})
#: Binary arithmetic operators (pop b, pop a, push a <op> b).
BINOPS = frozenset({ADD, SUB, MUL, DIV, MOD})
#: Control-flow instructions whose operand is a jump target (instruction index).
JUMPS = frozenset({JMP, JZ, JNZ})

MAX_STACK = 256
