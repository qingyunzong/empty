#include "regx/eval.hpp"

namespace regx {
namespace {

uint64_t loadReg(const RegValues& regs, const std::string& name, unsigned width) {
  auto it = regs.find(name);
  if (it == regs.end())
    throw RuntimeError("register '" + name + "' has no value");
  uint64_t v = it->second;
  if ((v & ~maskFor(width)) != 0)
    throw RuntimeError("register '" + name + "' value does not fit in " +
                       std::to_string(width) + " bits");
  return v;
}

} // namespace

uint64_t eval(const Expr& e, const RegValues& regs) {
  return std::visit(
      overloaded{
          [](const Literal& n) { return n.bits; },
          [&](const RegRef& n) { return loadReg(regs, n.name, e.width); },
          [&](const Slice& n) {
            uint64_t v = eval(*n.base, regs);
            return (v >> n.lo) & maskFor(e.width);
          },
          [&](const Concat& n) {
            uint64_t acc = 0;
            for (const auto& part : n.parts)
              acc = (acc << part->width) | eval(*part, regs);
            return acc;
          },
          [&](const Add& n) {
            uint64_t a = eval(*n.lhs, regs);
            uint64_t b = eval(*n.rhs, regs);
            return (a + b) & maskFor(e.width); // wraps mod 2^width
          },
          [&](const Shl& n) {
            uint64_t v = eval(*n.value, regs);
            uint64_t k = eval(*n.amount, regs);
            if (k >= e.width) return uint64_t{0};
            return (v << k) & maskFor(e.width);
          },
          [&](const Shr& n) {
            uint64_t v = eval(*n.value, regs);
            uint64_t k = eval(*n.amount, regs);
            if (k >= e.width) return uint64_t{0};
            return v >> k;
          },
          [&](const Eq& n) {
            return eval(*n.lhs, regs) == eval(*n.rhs, regs) ? uint64_t{1}
                                                            : uint64_t{0};
          },
          [&](const Ne& n) {
            return eval(*n.lhs, regs) != eval(*n.rhs, regs) ? uint64_t{1}
                                                            : uint64_t{0};
          },
          [&](const LAnd& n) {
            if (eval(*n.lhs, regs) == 0) return uint64_t{0};
            return eval(*n.rhs, regs) != 0 ? uint64_t{1} : uint64_t{0};
          },
          [&](const LOr& n) {
            if (eval(*n.lhs, regs) != 0) return uint64_t{1};
            return eval(*n.rhs, regs) != 0 ? uint64_t{1} : uint64_t{0};
          },
          [&](const Ternary& n) {
            if (eval(*n.cond, regs) != 0) return eval(*n.ifTrue, regs);
            return eval(*n.ifFalse, regs);
          },
      },
      e.node);
}

} // namespace regx
