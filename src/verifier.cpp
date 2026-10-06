#include "regx/verifier.hpp"

#include <optional>
#include <utility>

namespace regx {
namespace {

using Stack = std::vector<uint8_t>;

std::string at(size_t pc) { return " at instruction " + std::to_string(pc); }

} // namespace

void verify(const Program& prog) {
  const auto& code = prog.code;
  if (code.empty()) throw VerifyError("empty program");
  if (prog.regNames.size() != prog.regWidths.size())
    throw VerifyError("register name/width table size mismatch");
  for (uint8_t w : prog.regWidths)
    if (!validWidth(w)) throw VerifyError("invalid register width");
  if (!validWidth(prog.resultWidth)) throw VerifyError("invalid result width");

  std::vector<std::optional<Stack>> in(code.size());
  std::vector<std::pair<size_t, Stack>> worklist;
  worklist.push_back({0, Stack{}});

  auto merge = [&](size_t pc, const Stack& st, size_t from) {
    if (pc >= code.size())
      throw VerifyError("jump target out of range" + at(from));
    if (in[pc]) {
      if (*in[pc] != st)
        throw VerifyError("inconsistent stack type at jump target" + at(pc));
    } else {
      in[pc] = st;
      worklist.push_back({pc, st});
    }
  };

  while (!worklist.empty()) {
    auto [pc, st] = std::move(worklist.back());
    worklist.pop_back();
    const Instr& ins = code[pc];
    auto need = [&](size_t n) {
      if (st.size() < n) throw VerifyError("stack underflow" + at(pc));
    };
    switch (ins.op) {
      case OpCode::PushConst:
        if (!validWidth(ins.immWidth))
          throw VerifyError("invalid constant width" + at(pc));
        if (ins.immWidth < 64 && (ins.immValue >> ins.immWidth) != 0)
          throw VerifyError("constant does not fit its width" + at(pc));
        st.push_back(ins.immWidth);
        merge(pc + 1, st, pc);
        break;
      case OpCode::LoadReg:
        if (ins.immA >= prog.regWidths.size())
          throw VerifyError("register slot out of range" + at(pc));
        st.push_back(prog.regWidths[ins.immA]);
        merge(pc + 1, st, pc);
        break;
      case OpCode::Add: {
        need(2);
        uint8_t b = st.back();
        st.pop_back();
        uint8_t a = st.back();
        st.pop_back();
        st.push_back(std::max(a, b));
        merge(pc + 1, st, pc);
        break;
      }
      case OpCode::Shl:
      case OpCode::Shr:
        need(2);
        st.pop_back(); // amount; result keeps the value's width
        merge(pc + 1, st, pc);
        break;
      case OpCode::Slice: {
        need(1);
        uint8_t hi = static_cast<uint8_t>(ins.immA);
        uint8_t lo = static_cast<uint8_t>(ins.immB);
        if (lo > hi || hi >= st.back() ||
            hi - lo + 1 < static_cast<int>(kMinWidth))
          throw VerifyError("illegal slice" + at(pc));
        st.back() = static_cast<uint8_t>(hi - lo + 1);
        merge(pc + 1, st, pc);
        break;
      }
      case OpCode::Concat2: {
        need(2);
        unsigned lo = st.back();
        st.pop_back();
        unsigned hi = st.back();
        st.pop_back();
        if (hi + lo > kMaxWidth)
          throw VerifyError("concatenation wider than 64 bits" + at(pc));
        st.push_back(static_cast<uint8_t>(hi + lo));
        merge(pc + 1, st, pc);
        break;
      }
      case OpCode::Eq:
      case OpCode::Ne:
        need(2);
        st.pop_back();
        st.pop_back();
        st.push_back(kMinWidth);
        merge(pc + 1, st, pc);
        break;
      case OpCode::JumpIfFalse:
      case OpCode::JumpIfTrue:
        need(1);
        st.pop_back();
        merge(pc + 1, st, pc);
        merge(ins.immA, st, pc);
        break;
      case OpCode::Jump:
        merge(ins.immA, st, pc);
        break;
      case OpCode::Halt:
        if (st != Stack{prog.resultWidth})
          throw VerifyError("halt stack does not match the result type" + at(pc));
        break;
    }
  }
}

} // namespace regx
