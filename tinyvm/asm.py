"""A tiny two-pass assembler used by the compiler, tests and examples.

``assemble`` takes a list of items:
  * a plain string            -> label definition at the current offset
  * ("OP",)                   -> operand-less instruction
  * ("OP", int)               -> instruction with numeric operand
  * ("OP", "label")           -> jump/call to a label

Returns the assembled code bytes.
"""

from .isa import encode, instr_size


def assemble(items):
    labels = {}
    offset = 0
    for item in items:
        if isinstance(item, str):
            if item in labels:
                raise ValueError(f"duplicate label {item!r}")
            labels[item] = offset
        else:
            offset += instr_size(item[0])
    code = bytearray()
    for item in items:
        if isinstance(item, str):
            continue
        name = item[0]
        operand = item[1] if len(item) > 1 else None
        if isinstance(operand, str):
            if operand not in labels:
                raise ValueError(f"undefined label {operand!r}")
            operand = labels[operand]
        code += encode(name, operand)
    return bytes(code)
