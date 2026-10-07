#include "check.hpp"

#include <rex/rex.hpp>

#include <cstdint>
#include <random>
#include <string>
#include <vector>

using namespace rex;

// Two 8-bit registers: the full input space is 256 x 256 = 65536
// assignments, small enough to enumerate for every test expression.
static const std::vector<RegDecl> kRegs = {{"r0", 8}, {"r1", 8}};

// Random well-typed expression generator (deterministic seed). All
// leaves are 8-bit registers or literals, so every generated program
// can be checked over the whole input space.
struct Gen {
  std::mt19937_64 rng;

  explicit Gen(uint64_t seed) : rng(seed) {}

  int pick(int lo, int hi) {
    return std::uniform_int_distribution<int>(lo, hi)(rng);
  }

  std::string lit(int width) {
    const uint64_t v = rng() & mask_for(static_cast<uint8_t>(width));
    return std::to_string(width) + "'d" + std::to_string(v);
  }

  // Generates an expression of exactly `width` bits.
  std::string expr(int width, int depth) {
    if (depth <= 0) {
      if (width == 8)
        return pick(0, 1) ? "r0" : "r1";
      if (width > 8)
        return lit(width);
      return "r0[" + std::to_string(width - 1) + ":0]";
    }
    for (;;) {
      const int c = pick(0, 7);
      switch (c) {
      case 0: // base case
        if (width == 8)
          return pick(0, 1) ? "r0" : "r1";
        if (width >= 8)
          return lit(width);
        return "r1[" + std::to_string(width - 1) + ":0]";
      case 1: // addition modulo the result width
        return "(" + expr(width, depth - 1) + " + " + expr(width, depth - 1) +
               ")";
      case 2: // shifts keep the left operand's width
        return "(" + expr(width, depth - 1) +
               (pick(0, 1) ? " << " : " >> ") + expr(8, depth - 1) + ")";
      case 3: { // slice of a wider expression
        if (width >= 64)
          continue;
        const int w2 = pick(width + 1, 64);
        return "(" + expr(w2, depth - 1) + ")[" + std::to_string(width - 1) +
               ":0]";
      }
      case 4: { // concatenation of two parts
        if (width < 2)
          continue;
        const int a = pick(1, width - 1);
        return "{" + expr(a, depth - 1) + ", " + expr(width - a, depth - 1) +
               "}";
      }
      case 5: // conditional
        return "(" + expr(pick(1, 8), depth - 1) + " ? " +
               expr(width, depth - 1) + " : " + expr(width, depth - 1) + ")";
      case 6: // comparison / logic, only 1-bit results
        if (width != 1)
          continue;
        switch (pick(0, 3)) {
        case 0:
          return "(" + expr(8, depth - 1) + " == " + expr(8, depth - 1) + ")";
        case 1:
          return "(" + expr(8, depth - 1) + " != " + expr(8, depth - 1) + ")";
        case 2:
          return "(" + expr(1, depth - 1) + " && " + expr(1, depth - 1) + ")";
        default:
          return "(" + expr(1, depth - 1) + " || " + expr(1, depth - 1) + ")";
        }
      default: // literal or register of matching width
        if (width == 8)
          return pick(0, 1) ? "r0" : "r1";
        if (width >= 8)
          return lit(width);
        continue;
      }
    }
  }
};

static int g_checked = 0;

// Enumerates all 65536 (r0, r1) inputs and requires the VM to agree
// with AST evaluation on every single one.
static void check_exhaustive(const std::string& src) {
  const Expr e = Parser(src, kRegs).parse();
  const Program p = compile(e, kRegs);
  const auto verr = verify(p);
  if (verr) {
    std::fprintf(stderr, "verify failed for '%s': %s\n", src.c_str(),
                 verr->c_str());
    CHECK(!"verify failed");
    return;
  }
  RegFile rf = RegFile::from_decls(kRegs);
  for (uint32_t a = 0; a < 256; ++a) {
    rf.write("r0", a);
    for (uint32_t b = 0; b < 256; ++b) {
      rf.write("r1", b);
      const EvalResult want = eval(e, rf);
      VM vm(p, rf);
      const VM::Status s = vm.run();
      const auto* v = std::get_if<Value>(&want);
      CHECK(v != nullptr);
      CHECK(s == VM::Status::Done);
      if (!v || s != VM::Status::Done)
        return;
      if (!value_eq(vm.result(), *v)) {
        std::fprintf(stderr, "expr: %s r0=%u r1=%u\n", src.c_str(), a, b);
        CHECK(!"VM/AST mismatch");
        return;
      }
    }
  }
  ++g_checked;
}

int main() {
  // Hand-picked expressions covering every operator and its edges.
  const char* fixed[] = {
      "r0 + r1",
      "(r0 + r1) + (r0 + r1)",
      "r0 << r1",
      "r0 >> r1",
      "(r0 << r1) + (r1 >> r0)",
      "r0 == r1",
      "r0 != r1",
      "r0 && r1",
      "r0 || r1",
      "(r0 == r1) && (r0 != r1)",
      "r0 ? r1 : r0",
      "(r0 + r1) ? r0 : r1",
      "r0[3:0]",
      "r0[7:4]",
      "r0[0:0]",
      "r0[7:0]",
      "(r0 + r1)[3:0]",
      "{r0, r1}",
      "{r0, r1}[15:8]",
      "{r0[3:0], r1[3:0]}",
      "{r0, r0, r0, r0, r0, r0, r0, r0}",
      "{r0, r1} + {r1, r0}",
      "r0 ? {r0, r0} : {r1, r1}",
      "(r0 && r1) ? r0 + r1 : r0 << r1",
      "8'hff + r0",
      "8'd1 << r0",
      "255 >> r0",
  };
  for (const char* src : fixed)
    check_exhaustive(src);

  // Random expressions of various widths, depth-limited.
  Gen gen(0x5eedu);
  for (int i = 0; i < 48; ++i) {
    const int width = gen.pick(1, 32);
    check_exhaustive(gen.expr(width, 3));
  }

  std::printf("exhaustively checked %d expressions x 65536 inputs\n",
              g_checked);
  return check::summary("test_exhaustive");
}
