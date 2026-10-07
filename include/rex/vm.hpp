#pragma once

#include "bytecode.hpp"
#include "regs.hpp"
#include "value.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace rex {

// Pausable stack-machine interpreter. The VM expects a verified
// program (see verify()). Execution can be single-stepped with step()
// or bounded with run(fuel); the whole machine state (pc, stack,
// register file) is plain data, so a VM can be copied at any
// instruction boundary and resumed later with identical results.
class VM {
public:
  enum class Status { Paused, Done, Error };

  explicit VM(const Program& prog)
      : prog_(&prog), regs_(RegFile::from_decls(prog.regs)) {}

  VM(const Program& prog, RegFile regs)
      : prog_(&prog), regs_(std::move(regs)) {}

  RegFile& regs() { return regs_; }
  const RegFile& regs() const { return regs_; }
  Status status() const { return status_; }
  size_t pc() const { return pc_; }
  const std::vector<Value>& stack() const { return stack_; }
  const std::string& error() const { return error_; }
  Value result() const { return result_; }

  // Executes exactly one instruction (unless already halted).
  Status step() {
    if (status_ != Status::Paused)
      return status_;
    const Instr& ins = prog_->code[pc_];
    switch (ins.op) {
    case Op::PushConst:
      stack_.push_back(make_value(ins.width, ins.imm));
      ++pc_;
      break;
    case Op::Load: {
      const auto& v = regs_.values[ins.aux];
      if (!v)
        return fail("read of unwritten register '" +
                    regs_.names[ins.aux] + "'");
      stack_.push_back(make_value(ins.width, *v));
      ++pc_;
      break;
    }
    case Op::Add: {
      const Value b = pop();
      const Value a = pop();
      stack_.push_back(make_value(ins.width, a.bits + b.bits));
      ++pc_;
      break;
    }
    case Op::Shl:
    case Op::Shr: {
      const Value amt = pop();
      const Value v = pop();
      uint64_t r;
      if (amt.bits >= ins.width)
        r = 0; // shift amount at or beyond the width yields zero
      else if (ins.op == Op::Shl)
        r = v.bits << amt.bits;
      else
        r = v.bits >> amt.bits;
      stack_.push_back(make_value(ins.width, r));
      ++pc_;
      break;
    }
    case Op::Eq:
    case Op::Ne: {
      const Value b = pop();
      const Value a = pop();
      const bool eq = a.bits == b.bits;
      stack_.push_back(make_value(1, (ins.op == Op::Eq) == eq ? 1 : 0));
      ++pc_;
      break;
    }
    case Op::Jz: {
      const Value c = pop();
      pc_ = c.bits == 0 ? static_cast<size_t>(ins.imm) : pc_ + 1;
      break;
    }
    case Op::Jmp:
      pc_ = static_cast<size_t>(ins.imm);
      break;
    case Op::Slice: {
      const Value v = pop();
      stack_.push_back(make_value(ins.width, v.bits >> ins.imm));
      ++pc_;
      break;
    }
    case Op::Concat: {
      const size_t n = ins.aux;
      uint64_t acc = 0;
      uint32_t acc_width = 0;
      for (size_t i = stack_.size() - n; i < stack_.size(); ++i) {
        const Value v = stack_[i];
        if (acc_width == 0)
          acc = v.bits; // avoids a 64-bit shift of the accumulator
        else
          acc = (acc << v.width) | v.bits;
        acc_width += v.width;
      }
      stack_.resize(stack_.size() - n);
      stack_.push_back(make_value(ins.width, acc));
      ++pc_;
      break;
    }
    case Op::Halt:
      result_ = stack_.back();
      status_ = Status::Done;
      break;
    }
    return status_;
  }

  // Runs at most `fuel` instructions, then pauses.
  Status run(uint64_t fuel) {
    while (fuel > 0 && status_ == Status::Paused) {
      step();
      --fuel;
    }
    return status_;
  }

  // Runs to completion (or error).
  Status run() {
    while (status_ == Status::Paused)
      step();
    return status_;
  }

private:
  Value pop() {
    const Value v = stack_.back();
    stack_.pop_back();
    return v;
  }

  Status fail(const std::string& msg) {
    error_ = msg;
    status_ = Status::Error;
    return status_;
  }

  const Program* prog_;
  RegFile regs_;
  size_t pc_ = 0;
  std::vector<Value> stack_;
  Status status_ = Status::Paused;
  std::string error_;
  Value result_{};
};

} // namespace rex
