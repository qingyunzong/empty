"""Compiler from expression trees to tinyvm bytecode containers.

An expression is either ``("const", k)`` or ``(op, left, right)`` with
``op`` in ``"+-*/%"``. The compiled program leaves exactly one value on
the stack and HALTs.
"""

from .isa import encode
from .loader import dump_program

_OP_TO_INSTR = {"+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD"}


def compile_expr(expr, consts, code):
    """Append code evaluating ``expr`` onto ``code`` (a bytearray)."""
    if expr[0] == "const":
        value = expr[1]
        try:
            index = consts.index(value)
        except ValueError:
            index = len(consts)
            consts.append(value)
        code += encode("CONST", index)
        return
    op, left, right = expr
    compile_expr(left, consts, code)
    compile_expr(right, consts, code)
    code += encode(_OP_TO_INSTR[op])


def build_program(expr):
    """Compile ``expr`` into a complete bytecode container (bytes)."""
    consts = []
    code = bytearray()
    compile_expr(expr, consts, code)
    code += encode("HALT")
    return dump_program(consts, bytes(code))
