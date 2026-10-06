#include "regx/compiler.hpp"

#include "regx/verifier.hpp"

namespace regx {
namespace {

Instr instr(OpCode op) {
  Instr i;
  i.op = op;
  return i;
}

Instr pushConst(uint64_t value, uint8_t width) {
  Instr i = instr(OpCode::PushConst);
  i.immValue = value;
  i.immWidth = width;
  return i;
}

void emit(const Expr& e, std::vector<Instr>& out, const Schema& schema) {
  std::visit(
      overloaded{
          [&](const Literal& n) { out.push_back(pushConst(n.bits, n.width)); },
          [&](const RegRef& n) {
            Instr i = instr(OpCode::LoadReg);
            i.immA = static_cast<uint32_t>(schema.indexOf(n.name));
            out.push_back(i);
          },
          [&](const Slice& n) {
            emit(*n.base, out, schema);
            Instr i = instr(OpCode::Slice);
            i.immA = n.hi;
            i.immB = n.lo;
            out.push_back(i);
          },
          [&](const Concat& n) {
            for (const auto& part : n.parts) emit(*part, out, schema);
            for (size_t k = 1; k < n.parts.size(); ++k)
              out.push_back(instr(OpCode::Concat2));
          },
          [&](const Add& n) {
            emit(*n.lhs, out, schema);
            emit(*n.rhs, out, schema);
            out.push_back(instr(OpCode::Add));
          },
          [&](const Shl& n) {
            emit(*n.value, out, schema);
            emit(*n.amount, out, schema);
            out.push_back(instr(OpCode::Shl));
          },
          [&](const Shr& n) {
            emit(*n.value, out, schema);
            emit(*n.amount, out, schema);
            out.push_back(instr(OpCode::Shr));
          },
          [&](const Eq& n) {
            emit(*n.lhs, out, schema);
            emit(*n.rhs, out, schema);
            out.push_back(instr(OpCode::Eq));
          },
          [&](const Ne& n) {
            emit(*n.lhs, out, schema);
            emit(*n.rhs, out, schema);
            out.push_back(instr(OpCode::Ne));
          },
          [&](const LAnd& n) {
            // lhs; JF L1; rhs; JF L1; push 1; J L2; L1: push 0; L2:
            emit(*n.lhs, out, schema);
            size_t j1 = out.size();
            out.push_back(instr(OpCode::JumpIfFalse));
            emit(*n.rhs, out, schema);
            size_t j2 = out.size();
            out.push_back(instr(OpCode::JumpIfFalse));
            out.push_back(pushConst(1, kMinWidth));
            size_t j3 = out.size();
            out.push_back(instr(OpCode::Jump));
            uint32_t l1 = static_cast<uint32_t>(out.size());
            out.push_back(pushConst(0, kMinWidth));
            uint32_t l2 = static_cast<uint32_t>(out.size());
            out[j1].immA = l1;
            out[j2].immA = l1;
            out[j3].immA = l2;
          },
          [&](const LOr& n) {
            // lhs; JT L1; rhs; JT L1; push 0; J L2; L1: push 1; L2:
            emit(*n.lhs, out, schema);
            size_t j1 = out.size();
            out.push_back(instr(OpCode::JumpIfTrue));
            emit(*n.rhs, out, schema);
            size_t j2 = out.size();
            out.push_back(instr(OpCode::JumpIfTrue));
            out.push_back(pushConst(0, kMinWidth));
            size_t j3 = out.size();
            out.push_back(instr(OpCode::Jump));
            uint32_t l1 = static_cast<uint32_t>(out.size());
            out.push_back(pushConst(1, kMinWidth));
            uint32_t l2 = static_cast<uint32_t>(out.size());
            out[j1].immA = l1;
            out[j2].immA = l1;
            out[j3].immA = l2;
          },
          [&](const Ternary& n) {
            // cond; JF L1; then; J L2; L1: else; L2:
            emit(*n.cond, out, schema);
            size_t j1 = out.size();
            out.push_back(instr(OpCode::JumpIfFalse));
            emit(*n.ifTrue, out, schema);
            size_t j2 = out.size();
            out.push_back(instr(OpCode::Jump));
            uint32_t l1 = static_cast<uint32_t>(out.size());
            emit(*n.ifFalse, out, schema);
            uint32_t l2 = static_cast<uint32_t>(out.size());
            out[j1].immA = l1;
            out[j2].immA = l2;
          },
      },
      e.node);
}

} // namespace

Program compile(const Expr& root, const Schema& schema) {
  Program p;
  for (const auto& [name, w] : schema.regs) {
    p.regNames.push_back(name);
    p.regWidths.push_back(w);
  }
  p.resultWidth = root.width;
  emit(root, p.code, schema);
  p.code.push_back(instr(OpCode::Halt));
  verify(p); // compiler output must always satisfy the verifier
  return p;
}

} // namespace regx
