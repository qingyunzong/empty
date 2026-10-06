#include "regx/vm.hpp"

namespace regx {

VM::VM(const Program& prog, std::vector<uint64_t> regValues)
    : prog_(&prog), regs_(std::move(regValues)) {}

VM::Status VM::fail(std::string msg) {
  status_ = Status::Error;
  error_ = std::move(msg);
  return status_;
}

VM::Status VM::step() {
  if (status_ != Status::Running) return status_;
  if (pc_ >= prog_->code.size()) return fail("program counter out of range");
  const Instr& ins = prog_->code[pc_];
  auto pop = [&] {
    Value v = stack_.back();
    stack_.pop_back();
    return v;
  };
  switch (ins.op) {
    case OpCode::PushConst:
      stack_.push_back({ins.immWidth, ins.immValue & maskFor(ins.immWidth)});
      ++pc_;
      break;
    case OpCode::LoadReg: {
      if (ins.immA >= prog_->regWidths.size())
        return fail("register slot out of range");
      unsigned w = prog_->regWidths[ins.immA];
      if (ins.immA >= regs_.size())
        return fail("register '" + prog_->regNames[ins.immA] + "' has no value");
      uint64_t v = regs_[ins.immA];
      if ((v & ~maskFor(w)) != 0)
        return fail("register '" + prog_->regNames[ins.immA] +
                    "' value does not fit in " + std::to_string(w) + " bits");
      stack_.push_back({static_cast<uint8_t>(w), v});
      ++pc_;
      break;
    }
    case OpCode::Add: {
      Value b = pop();
      Value a = pop();
      unsigned w = std::max(a.width, b.width);
      stack_.push_back({static_cast<uint8_t>(w), (a.bits + b.bits) & maskFor(w)});
      ++pc_;
      break;
    }
    case OpCode::Shl: {
      Value k = pop();
      Value v = pop();
      uint64_t r = k.bits >= v.width ? 0 : (v.bits << k.bits) & maskFor(v.width);
      stack_.push_back({v.width, r});
      ++pc_;
      break;
    }
    case OpCode::Shr: {
      Value k = pop();
      Value v = pop();
      uint64_t r = k.bits >= v.width ? 0 : v.bits >> k.bits;
      stack_.push_back({v.width, r});
      ++pc_;
      break;
    }
    case OpCode::Slice: {
      Value v = pop();
      unsigned hi = ins.immA, lo = ins.immB;
      unsigned w = hi - lo + 1;
      stack_.push_back({static_cast<uint8_t>(w), (v.bits >> lo) & maskFor(w)});
      ++pc_;
      break;
    }
    case OpCode::Concat2: {
      Value lo = pop();
      Value hi = pop();
      unsigned w = static_cast<unsigned>(hi.width) + lo.width;
      stack_.push_back({static_cast<uint8_t>(w), (hi.bits << lo.width) | lo.bits});
      ++pc_;
      break;
    }
    case OpCode::Eq: {
      Value b = pop();
      Value a = pop();
      stack_.push_back({kMinWidth, a.bits == b.bits ? 1u : 0u});
      ++pc_;
      break;
    }
    case OpCode::Ne: {
      Value b = pop();
      Value a = pop();
      stack_.push_back({kMinWidth, a.bits != b.bits ? 1u : 0u});
      ++pc_;
      break;
    }
    case OpCode::JumpIfFalse: {
      Value c = pop();
      pc_ = c.bits == 0 ? ins.immA : pc_ + 1;
      break;
    }
    case OpCode::JumpIfTrue: {
      Value c = pop();
      pc_ = c.bits != 0 ? ins.immA : pc_ + 1;
      break;
    }
    case OpCode::Jump:
      pc_ = ins.immA;
      break;
    case OpCode::Halt:
      if (stack_.empty()) return fail("halt with empty stack");
      result_ = stack_.back().bits;
      status_ = Status::Done;
      break;
  }
  return status_;
}

VM::Status VM::run() {
  while (status_ == Status::Running) step();
  return status_;
}

} // namespace regx
