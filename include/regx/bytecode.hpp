#pragma once

#include "regx/value.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace regx {

enum class OpCode : uint8_t {
  PushConst,   // immValue/immWidth: push constant
  LoadReg,     // immA = register slot; runtime error if value does not fit
  Add,         // pop b, a; push (a + b) mod 2^max(wa, wb)
  Shl,         // pop amount, value; push value << amount (0 if amount >= width)
  Shr,         // pop amount, value; push value >> amount (0 if amount >= width)
  Slice,       // immA = hi, immB = lo; pop v; push v[hi:lo]
  Concat2,     // pop lo, hi; push {hi, lo}
  Eq,          // pop b, a; push 8-bit (a == b)
  Ne,          // pop b, a; push 8-bit (a != b)
  JumpIfFalse, // immA = target; pop cond; jump if cond == 0
  JumpIfTrue,  // immA = target; pop cond; jump if cond != 0
  Jump,        // immA = target
  Halt,        // stop; top of stack is the result
};

struct Instr {
  OpCode op;
  uint64_t immValue = 0;
  uint32_t immA = 0;
  uint32_t immB = 0;
  uint8_t immWidth = 0;
};

struct Program {
  std::vector<Instr> code;
  std::vector<std::string> regNames;   // slot -> name
  std::vector<uint8_t> regWidths;      // slot -> declared width
  uint8_t resultWidth = 0;

  std::string disassemble() const;
};

} // namespace regx
