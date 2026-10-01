"""The tinyvm interpreter.

Machine model:

- a single operand stack shared across frames (CALL arguments and
  return values travel on it), limited to ``stack_limit`` entries
- a call stack of frames; each frame owns a fresh ``nlocals`` local
  array and a return address, limited to ``frame_limit`` frames
  (the main frame counts as one)
- a step counter limited to ``step_limit`` executed instructions

All failures raise subclasses of RuntimeFault carrying the pc and step
count, so the exception state is fully deterministic and reproducible.
With ``trace`` enabled, every instruction is logged (before execution)
to ``trace_out`` as ``step=<n> pc=<n> op=<NAME> [arg=<n>] stack=[...]``;
on a fault the already-executed prefix is therefore visible on stderr.
"""

from __future__ import annotations

import sys

from . import isa
from .errors import (
    EmptyHalt,
    FrameOverflow,
    RuntimeFault,
    StackOverflow,
    StepLimit,
)

OP = isa.OPCODES

DEFAULT_STEP_LIMIT = 1_000_000
DEFAULT_STACK_LIMIT = 256
DEFAULT_FRAME_LIMIT = 64


class VM:
    def __init__(
        self,
        program,
        step_limit=DEFAULT_STEP_LIMIT,
        stack_limit=DEFAULT_STACK_LIMIT,
        frame_limit=DEFAULT_FRAME_LIMIT,
        trace=False,
        trace_out=None,
    ):
        self.program = program
        self.step_limit = step_limit
        self.stack_limit = stack_limit
        self.frame_limit = frame_limit
        self.trace = trace
        self.trace_out = trace_out if trace_out is not None else sys.stderr

        self.stack = []
        # Frames hold [return_pc, locals]; the main frame returns to -1.
        self.frames = [[-1, [0] * program.nlocals]]
        self.pc = 0
        self.steps = 0
        self.halted = False

    # -- helpers ------------------------------------------------------

    def _fault(self, exc_cls, message):
        raise exc_cls(message, pc=self.pc, step=self.steps)

    def _push(self, value):
        if len(self.stack) >= self.stack_limit:
            self._fault(
                StackOverflow,
                "operand stack limit %d exceeded" % self.stack_limit,
            )
        self.stack.append(value)

    def _pop(self):
        if not self.stack:
            self._fault(RuntimeFault, "operand stack underflow")
        return self.stack.pop()

    def _pop2(self):
        rhs = self._pop()
        lhs = self._pop()
        return lhs, rhs

    def _trace(self, opcode, operand):
        name = isa.NAMES[opcode]
        line = "step=%d pc=%d op=%s" % (self.steps, self.pc, name)
        if operand is not None:
            line += " arg=%d" % operand
        line += " stack=%r" % (self.stack,)
        print(line, file=self.trace_out)

    # -- main loop ----------------------------------------------------

    def run(self):
        code = self.program.code
        while not self.halted:
            if self.pc < 0 or self.pc >= len(code):
                self._fault(RuntimeFault, "pc %d out of code range" % self.pc)
            if self.steps >= self.step_limit:
                self._fault(
                    StepLimit, "step limit %d exceeded" % self.step_limit
                )
            opcode, operand, size = isa.decode(code, self.pc)
            if self.trace:
                self._trace(opcode, operand)
            self._execute(opcode, operand, size)
            self.steps += 1
        if not self.stack:
            raise EmptyHalt("HALT with empty operand stack", pc=self.pc, step=self.steps)
        return self.stack[-1]

    def _execute(self, opcode, operand, size):
        next_pc = self.pc + size

        if opcode == OP["CONST"]:
            self._push(self.program.consts[operand])
        elif opcode == OP["LOAD"]:
            self._push(self.frames[-1][1][operand])
        elif opcode == OP["STORE"]:
            self.frames[-1][1][operand] = self._pop()
        elif opcode == OP["ADD"]:
            lhs, rhs = self._pop2()
            self._push(lhs + rhs)
        elif opcode == OP["SUB"]:
            lhs, rhs = self._pop2()
            self._push(lhs - rhs)
        elif opcode == OP["MUL"]:
            lhs, rhs = self._pop2()
            self._push(lhs * rhs)
        elif opcode == OP["DIV"]:
            lhs, rhs = self._pop2()
            if rhs == 0:
                self._fault(RuntimeFault, "division by zero in DIV")
            self._push(lhs // rhs)
        elif opcode == OP["MOD"]:
            lhs, rhs = self._pop2()
            if rhs == 0:
                self._fault(RuntimeFault, "division by zero in MOD")
            self._push(lhs % rhs)
        elif opcode == OP["JMP"]:
            next_pc = operand
        elif opcode == OP["JZ"]:
            if self._pop() == 0:
                next_pc = operand
        elif opcode == OP["JNZ"]:
            if self._pop() != 0:
                next_pc = operand
        elif opcode == OP["CALL"]:
            if len(self.frames) >= self.frame_limit:
                self._fault(
                    FrameOverflow,
                    "call frame limit %d exceeded" % self.frame_limit,
                )
            self.frames.append([next_pc, [0] * self.program.nlocals])
            next_pc = operand
        elif opcode == OP["RET"]:
            if len(self.frames) <= 1:
                self._fault(RuntimeFault, "RET with no caller")
            return_pc, _ = self.frames.pop()
            next_pc = return_pc
        elif opcode == OP["HALT"]:
            self.halted = True
        else:  # pragma: no cover - load-time verification prevents this
            self._fault(RuntimeFault, "unknown opcode 0x%02x" % opcode)

        self.pc = next_pc
