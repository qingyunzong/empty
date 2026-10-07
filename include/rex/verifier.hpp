#pragma once

#include "bytecode.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace rex {

// Statically verifies a program's stack typing. Every instruction
// boundary reachable from the entry is assigned a stack type (the
// sequence of value widths on the stack); in particular, every jump
// entry must be reached with the same stack type from all of its
// predecessors. Returns an error message, or nullopt if the program
// is well formed.
inline std::optional<std::string> verify(const Program& prog) {
  using Stack = std::vector<uint8_t>;
  const auto& code = prog.code;
  if (code.empty())
    return "empty program";
  std::vector<std::optional<Stack>> in(code.size());
  std::vector<size_t> work;
  in[0] = Stack{};
  work.push_back(0);
  auto merge = [&](size_t pc, const Stack& s) -> std::optional<std::string> {
    if (pc >= code.size())
      return "jump target out of range: " + std::to_string(pc);
    if (in[pc]) {
      if (*in[pc] != s)
        return "stack type mismatch at jump entry " + std::to_string(pc);
    } else {
      in[pc] = s;
      work.push_back(pc);
    }
    return std::nullopt;
  };
  while (!work.empty()) {
    const size_t pc = work.back();
    work.pop_back();
    Stack s = *in[pc];
    const Instr& ins = code[pc];
    auto pop = [&]() -> std::optional<uint8_t> {
      if (s.empty())
        return std::nullopt;
      const uint8_t w = s.back();
      s.pop_back();
      return w;
    };
    auto fall_through = [&]() -> std::optional<std::string> {
      if (pc + 1 >= code.size())
        return std::string("execution falls off the end of the program");
      return merge(pc + 1, s);
    };
    const std::string at = " at instruction " + std::to_string(pc);
    switch (ins.op) {
    case Op::PushConst:
      if (ins.width < 1 || ins.width > 64)
        return "bad constant width" + at;
      if (ins.imm != (ins.imm & mask_for(ins.width)))
        return "constant does not fit its width" + at;
      s.push_back(ins.width);
      if (auto e = fall_through()) return e;
      break;
    case Op::Load:
      if (ins.aux >= prog.regs.size())
        return "register index out of range" + at;
      s.push_back(ins.width);
      if (auto e = fall_through()) return e;
      break;
    case Op::Add: {
      auto b = pop();
      auto a = pop();
      if (!a || !b)
        return "stack underflow" + at;
      if (*a != ins.width || *b != ins.width)
        return "operand type mismatch" + at;
      s.push_back(ins.width);
      if (auto e = fall_through()) return e;
      break;
    }
    case Op::Shl:
    case Op::Shr: {
      auto amt = pop();
      auto v = pop();
      if (!amt || !v)
        return "stack underflow" + at;
      if (*v != ins.width)
        return "operand type mismatch" + at;
      s.push_back(ins.width);
      if (auto e = fall_through()) return e;
      break;
    }
    case Op::Eq:
    case Op::Ne: {
      auto b = pop();
      auto a = pop();
      if (!a || !b)
        return "stack underflow" + at;
      if (*a != ins.width || *b != ins.width)
        return "operand type mismatch" + at;
      s.push_back(1);
      if (auto e = fall_through()) return e;
      break;
    }
    case Op::Jz: {
      if (!pop())
        return "stack underflow" + at;
      if (auto e = merge(static_cast<size_t>(ins.imm), s)) return e;
      if (auto e = fall_through()) return e;
      break;
    }
    case Op::Jmp:
      if (auto e = merge(static_cast<size_t>(ins.imm), s)) return e;
      break;
    case Op::Slice: {
      auto v = pop();
      if (!v)
        return "stack underflow" + at;
      if (ins.imm > ins.aux || ins.aux >= *v)
        return "slice out of range" + at;
      if (ins.width != ins.aux - ins.imm + 1)
        return "slice width mismatch" + at;
      s.push_back(ins.width);
      if (auto e = fall_through()) return e;
      break;
    }
    case Op::Concat: {
      uint32_t total = 0;
      for (uint32_t i = 0; i < ins.aux; ++i) {
        auto v = pop();
        if (!v)
          return "stack underflow" + at;
        total += *v;
      }
      if (total != ins.width || total > 64)
        return "concat width mismatch" + at;
      s.push_back(ins.width);
      if (auto e = fall_through()) return e;
      break;
    }
    case Op::Halt:
      if (s.size() != 1 || s[0] != prog.result_width)
        return "stack at halt does not hold exactly the result value";
      break;
    }
  }
  return std::nullopt;
}

} // namespace rex
