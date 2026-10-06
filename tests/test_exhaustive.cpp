#include "regx/compiler.hpp"
#include "regx/eval.hpp"
#include "regx/parser.hpp"
#include "regx/vm.hpp"

#include "test_framework.hpp"

#include <random>

using namespace regx;

namespace {

Schema schema(std::initializer_list<std::pair<std::string, uint8_t>> rs) {
  Schema s;
  s.regs.assign(rs);
  return s;
}

uint64_t vmRun(const Program& p, std::vector<uint64_t> regs) {
  VM vm(p, std::move(regs));
  if (vm.run() != VM::Status::Done)
    throw std::runtime_error("VM error: " + vm.error());
  return vm.result();
}

ExprPtr mk(Node n, unsigned w) {
  return std::make_unique<Expr>(Expr{std::move(n), static_cast<uint8_t>(w), 0});
}

// Random expression generator for differential AST-vs-VM testing.
struct Gen {
  std::mt19937_64& rng;
  const Schema& s;

  uint64_t bits(unsigned n) { return rng() & maskFor(n); }

  ExprPtr leaf() {
    if (!s.regs.empty() && (rng() & 1)) {
      size_t i = rng() % s.regs.size();
      return mk(RegRef{s.regs[i].first}, s.regs[i].second);
    }
    unsigned w = (rng() & 1) ? 8 : 16;
    return mk(Literal{bits(w), static_cast<uint8_t>(w)}, w);
  }

  ExprPtr toWidth8(ExprPtr e) {
    return mk(Slice{std::move(e), 7, 0}, 8);
  }

  ExprPtr gen(int depth) {
    if (depth <= 0) return leaf();
    switch (rng() % 9) {
      case 0: {
        auto a = gen(depth - 1), b = gen(depth - 1);
        unsigned w = std::max(a->width, b->width);
        return mk(Add{std::move(a), std::move(b)}, w);
      }
      case 1:
      case 2: {
        auto v = gen(depth - 1);
        unsigned w = v->width;
        auto k = mk(Literal{bits(8), 8}, 8); // exercises amount >= width
        if (rng() & 1) return mk(Shl{std::move(v), std::move(k)}, w);
        return mk(Shr{std::move(v), std::move(k)}, w);
      }
      case 3: {
        auto base = gen(depth - 1);
        unsigned bw = base->width;
        unsigned w = 8 + rng() % (bw - 7);
        unsigned lo = rng() % (bw - w + 1);
        unsigned hi = lo + w - 1;
        return mk(Slice{std::move(base), static_cast<uint8_t>(hi),
                        static_cast<uint8_t>(lo)},
                  w);
      }
      case 4: {
        auto a = gen(depth - 1), b = gen(depth - 1);
        unsigned w = static_cast<unsigned>(a->width) + b->width;
        if (w > 64) return leaf();
        std::vector<ExprPtr> parts;
        parts.push_back(std::move(a));
        parts.push_back(std::move(b));
        return mk(Concat{std::move(parts)}, w);
      }
      case 5: {
        auto a = gen(depth - 1), b = gen(depth - 1);
        if (rng() & 1) return mk(Eq{std::move(a), std::move(b)}, 8);
        return mk(Ne{std::move(a), std::move(b)}, 8);
      }
      case 6: {
        auto a = gen(depth - 1), b = gen(depth - 1);
        if (rng() & 1) return mk(LAnd{std::move(a), std::move(b)}, 8);
        return mk(LOr{std::move(a), std::move(b)}, 8);
      }
      case 7: {
        auto c = gen(depth - 1);
        auto t = toWidth8(gen(depth - 1));
        auto f = toWidth8(gen(depth - 1));
        return mk(Ternary{std::move(c), std::move(t), std::move(f)}, 8);
      }
      default:
        return leaf();
    }
  }
};

} // namespace

TEST(exhaustive_add_8bit) {
  auto s = schema({{"a", 8}, {"b", 8}});
  auto ast = parse("a + b", s);
  Program p = compile(*ast, s);
  for (unsigned a = 0; a < 256; ++a)
    for (unsigned b = 0; b < 256; ++b) {
      uint64_t want = (a + b) & 0xFF;
      CHECK_EQ(eval(*ast, {{"a", a}, {"b", b}}), want);
      CHECK_EQ(vmRun(p, {a, b}), want);
    }
}

TEST(exhaustive_add_mixed_width) {
  auto s = schema({{"a", 8}, {"b", 16}});
  auto ast = parse("a + b", s);
  Program p = compile(*ast, s);
  for (unsigned a = 0; a < 256; ++a)
    for (unsigned b = 0; b < 65536; b += 16) {
      uint64_t want = (a + b) & 0xFFFF;
      CHECK_EQ(eval(*ast, {{"a", a}, {"b", b}}), want);
      CHECK_EQ(vmRun(p, {a, b}), want);
    }
  // Edge: carry out of the narrow operand is kept by the wider result.
  CHECK_EQ(vmRun(p, {255, 65535}), (255 + 65535) & 0xFFFF);
  CHECK_EQ(vmRun(p, {255, 1}), 256);
}

TEST(exhaustive_shifts_8bit) {
  auto s = schema({{"a", 8}, {"k", 8}});
  auto shl = parse("a << k", s);
  auto shr = parse("a >> k", s);
  Program pl = compile(*shl, s), pr = compile(*shr, s);
  for (unsigned a = 0; a < 256; ++a)
    for (unsigned k = 0; k < 256; ++k) {
      uint64_t wl = k >= 8 ? 0 : (a << k) & 0xFF;
      uint64_t wr = k >= 8 ? 0 : a >> k;
      RegValues v{{"a", a}, {"k", k}};
      CHECK_EQ(eval(*shl, v), wl);
      CHECK_EQ(eval(*shr, v), wr);
      CHECK_EQ(vmRun(pl, {a, k}), wl);
      CHECK_EQ(vmRun(pr, {a, k}), wr);
    }
}

TEST(exhaustive_slices_16bit) {
  auto s = schema({{"x", 16}});
  for (unsigned w = 8; w <= 16; ++w)
    for (unsigned lo = 0; lo + w <= 16; ++lo) {
      unsigned hi = lo + w - 1;
      std::string src =
          "x[" + std::to_string(hi) + ":" + std::to_string(lo) + "]";
      auto ast = parse(src, s);
      Program p = compile(*ast, s);
      for (unsigned x = 0; x < 65536; ++x) {
        uint64_t want = (x >> lo) & maskFor(w);
        CHECK_EQ(eval(*ast, {{"x", x}}), want);
        CHECK_EQ(vmRun(p, {x}), want);
      }
    }
}

TEST(exhaustive_concat_8bit) {
  auto s = schema({{"a", 8}, {"b", 8}});
  auto ast = parse("{a, b}", s);
  Program p = compile(*ast, s);
  for (unsigned a = 0; a < 256; ++a)
    for (unsigned b = 0; b < 256; ++b) {
      uint64_t want = (a << 8) | b;
      CHECK_EQ(eval(*ast, {{"a", a}, {"b", b}}), want);
      CHECK_EQ(vmRun(p, {a, b}), want);
    }
}

TEST(exhaustive_compare_and_logic_8bit) {
  auto s = schema({{"a", 8}, {"b", 8}});
  auto eq = parse("a == b", s);
  auto ne = parse("a != b", s);
  auto an = parse("a && b", s);
  auto lo = parse("a || b", s);
  Program pe = compile(*eq, s), pn = compile(*ne, s);
  Program pa = compile(*an, s), po = compile(*lo, s);
  for (unsigned a = 0; a < 256; ++a)
    for (unsigned b = 0; b < 256; ++b) {
      RegValues v{{"a", a}, {"b", b}};
      CHECK_EQ(eval(*eq, v), a == b);
      CHECK_EQ(eval(*ne, v), a != b);
      CHECK_EQ(eval(*an, v), (a && b) ? 1 : 0);
      CHECK_EQ(eval(*lo, v), (a || b) ? 1 : 0);
      CHECK_EQ(vmRun(pe, {a, b}), a == b);
      CHECK_EQ(vmRun(pn, {a, b}), a != b);
      CHECK_EQ(vmRun(pa, {a, b}), (a && b) ? 1 : 0);
      CHECK_EQ(vmRun(po, {a, b}), (a || b) ? 1 : 0);
    }
}

TEST(exhaustive_ternary_8bit) {
  auto s = schema({{"c", 8}, {"a", 8}, {"b", 8}});
  auto ast = parse("c ? a : b", s);
  Program p = compile(*ast, s);
  for (unsigned c : {0u, 1u, 2u, 255u})
    for (unsigned a = 0; a < 256; ++a)
      for (unsigned b = 0; b < 256; ++b) {
        uint64_t want = c ? a : b;
        CHECK_EQ(eval(*ast, {{"c", c}, {"a", a}, {"b", b}}), want);
        CHECK_EQ(vmRun(p, {c, a, b}), want);
      }
}

TEST(random_ast_vs_vm_with_resume) {
  auto s = schema({{"r0", 8}, {"r1", 16}, {"r2", 8}});
  std::mt19937_64 rng(0xC0FFEE);
  Gen g{rng, s};
  for (int iter = 0; iter < 400; ++iter) {
    auto ast = g.gen(4);
    RegValues vals;
    std::vector<uint64_t> slots;
    for (auto& [name, w] : s.regs) {
      uint64_t v = rng() & maskFor(w);
      vals[name] = v;
      slots.push_back(v);
    }
    uint64_t want = eval(*ast, vals);
    Program p = compile(*ast, s); // compiler output is verified internally
    CHECK_EQ(vmRun(p, slots), want);
    // Resume from a copy at every instruction boundary.
    VM vm(p, slots);
    size_t guard = 0;
    while (vm.status() == VM::Status::Running) {
      VM resumed = vm;
      CHECK_EQ(resumed.run(), VM::Status::Done);
      CHECK_EQ(resumed.result(), want);
      vm.step();
      CHECK(++guard < 100000);
    }
    CHECK_EQ(vm.result(), want);
  }
}

int main() { return tf::run(); }
