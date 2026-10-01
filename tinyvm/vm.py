"""The tinyvm interpreter.

Execution model:
  * one shared operand stack (max MAX_STACK values)
  * a call stack of frames (max MAX_FRAMES); each frame has its own
    zero-initialised locals and a program counter
  * CALL leaves arguments on the shared stack; the callee STOREs them
    into locals and leaves its return value on the stack before RET
  * at most STEP_LIMIT instructions may execute per run

DIV/MOD use truncating (C-style) semantics: the quotient rounds toward
zero and the remainder takes the sign of the dividend.
"""

import sys

from .errors import (
    EmptyHalt,
    FrameOverflow,
    RuntimeFault,
    StackOverflow,
    StepLimit,
)
from .isa import MAX_LOCALS, decode

MAX_STACK = 256
MAX_FRAMES = 64
STEP_LIMIT = 1_000_000


def div_trunc(a, b):
    """Integer division truncating toward zero. Raises on b == 0."""
    if b == 0:
        raise RuntimeFault("division by zero")
    quotient = abs(a) // abs(b)
    if (a < 0) != (b < 0):
        quotient = -quotient
    return quotient


def mod_trunc(a, b):
    """Remainder matching div_trunc (sign of the dividend)."""
    if b == 0:
        raise RuntimeFault("modulo by zero")
    return a - div_trunc(a, b) * b


class _Frame:
    __slots__ = ("pc", "locals")

    def __init__(self, pc):
        self.pc = pc
        self.locals = [0] * MAX_LOCALS


class VM:
    def __init__(self, program, trace=False, trace_file=None):
        self.program = program
        self.trace = trace
        self.trace_file = trace_file if trace_file is not None else sys.stderr
        self.stack = []
        self.frames = [_Frame(0)]
        self.steps = 0

    def _emit_trace(self, pc, name, operand):
        text = name if operand is None else f"{name} {operand}"
        self.trace_file.write(
            f"step={self.steps} pc={pc:04d} {text:<10} "
            f"stack={self.stack} frames={len(self.frames)}\n"
        )

    def _push(self, value):
        if len(self.stack) >= MAX_STACK:
            raise StackOverflow(f"operand stack limit {MAX_STACK} exceeded")
        self.stack.append(value)

    def _pop(self):
        if not self.stack:
            raise RuntimeFault("operand stack underflow")
        return self.stack.pop()

    def run(self):
        """Execute until HALT. Returns the top of the operand stack."""
        code = self.program.code
        consts = self.program.consts
        while True:
            if self.steps >= STEP_LIMIT:
                raise StepLimit(f"instruction step limit {STEP_LIMIT} exceeded")
            frame = self.frames[-1]
            pc = frame.pc
            if pc >= len(code):
                raise RuntimeFault(f"pc {pc} fell off code end {len(code)}")
            # The program was verified at load time, so decode cannot fail.
            name, operand, size = decode(code, pc)
            if self.trace:
                self._emit_trace(pc, name, operand)
            self.steps += 1
            frame.pc = pc + size

            if name == "CONST":
                self._push(consts[operand])
            elif name == "LOAD":
                self._push(frame.locals[operand])
            elif name == "STORE":
                frame.locals[operand] = self._pop()
            elif name == "ADD":
                b, a = self._pop(), self._pop()
                self._push(a + b)
            elif name == "SUB":
                b, a = self._pop(), self._pop()
                self._push(a - b)
            elif name == "MUL":
                b, a = self._pop(), self._pop()
                self._push(a * b)
            elif name == "DIV":
                b, a = self._pop(), self._pop()
                self._push(div_trunc(a, b))
            elif name == "MOD":
                b, a = self._pop(), self._pop()
                self._push(mod_trunc(a, b))
            elif name == "JMP":
                frame.pc = operand
            elif name == "JZ":
                if self._pop() == 0:
                    frame.pc = operand
            elif name == "JNZ":
                if self._pop() != 0:
                    frame.pc = operand
            elif name == "CALL":
                if len(self.frames) >= MAX_FRAMES:
                    raise FrameOverflow(
                        f"call frame limit {MAX_FRAMES} exceeded"
                    )
                self.frames.append(_Frame(operand))
            elif name == "RET":
                if len(self.frames) <= 1:
                    raise RuntimeFault("RET with no caller frame")
                self.frames.pop()
            elif name == "HALT":
                if not self.stack:
                    raise EmptyHalt("HALT with empty operand stack")
                return self.stack[-1]
            else:  # pragma: no cover - unreachable after verification
                raise RuntimeFault(f"unimplemented instruction {name}")
