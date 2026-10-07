#pragma once

#include "regs.hpp"

#include <cstdint>
#include <vector>

namespace rex {

enum class Op {
  PushConst, // push constant: width=width, imm=value
  Load,      // push register: aux=reg index, width=reg width
  Add,       // pop b, pop a (both `width`), push (a+b) mod 2^width
  Shl,       // pop amt, pop v (width=`width`), push v << amt (0 if amt>=width)
  Shr,       // pop amt, pop v (width=`width`), push v >> amt (0 if amt>=width)
  Eq,        // pop b, pop a (both `width`), push 1-bit (a == b)
  Ne,        // pop b, pop a (both `width`), push 1-bit (a != b)
  Jz,        // pop c; jump to imm if c == 0
  Jmp,       // jump to imm
  Slice,     // pop v, push v[aux:imm] (aux=hi, imm=lo), result width=width
  Concat,    // pop aux values (top = least significant), push concat
  Halt,      // stop; the sole stack entry is the result
};

struct Instr {
  Op op;
  uint8_t width = 0;
  uint64_t imm = 0;
  uint32_t aux = 0;
};

struct Program {
  std::vector<Instr> code;
  uint8_t result_width = 0;
  std::vector<RegDecl> regs;
};

} // namespace rex
