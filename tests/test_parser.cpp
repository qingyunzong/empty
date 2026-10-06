#include "regx/eval.hpp"
#include "regx/parser.hpp"

#include "test_framework.hpp"

using namespace regx;

namespace {

Schema schema(std::initializer_list<std::pair<std::string, uint8_t>> rs) {
  Schema s;
  s.regs.assign(rs);
  return s;
}

const Schema kEmpty{};

bool sameAst(const Expr& a, const Expr& b) {
  if (a.width != b.width || a.node.index() != b.node.index()) return false;
  return std::visit(
      overloaded{
          [](const Literal& x, const Literal& y) { return x.bits == y.bits; },
          [](const RegRef& x, const RegRef& y) { return x.name == y.name; },
          [](const Slice& x, const Slice& y) {
            return x.hi == y.hi && x.lo == y.lo && sameAst(*x.base, *y.base);
          },
          [](const Concat& x, const Concat& y) {
            if (x.parts.size() != y.parts.size()) return false;
            for (size_t i = 0; i < x.parts.size(); ++i)
              if (!sameAst(*x.parts[i], *y.parts[i])) return false;
            return true;
          },
          [](const auto& x, const auto& y) -> bool {
            if constexpr (requires { x.lhs; y.lhs; x.rhs; y.rhs; })
              return sameAst(*x.lhs, *y.lhs) && sameAst(*x.rhs, *y.rhs);
            else if constexpr (requires { x.cond; y.cond; })
              return sameAst(*x.cond, *y.cond) && sameAst(*x.ifTrue, *y.ifTrue) &&
                     sameAst(*x.ifFalse, *y.ifFalse);
            else if constexpr (requires { x.value; y.value; x.amount; y.amount; })
              return sameAst(*x.value, *y.value) && sameAst(*x.amount, *y.amount);
            else
              return false;
          },
      },
      a.node, b.node);
}

size_t errPos(const std::string& src, const Schema& s) {
  try {
    parse(src, s);
  } catch (const ParseError& e) {
    return e.pos;
  }
  throw std::runtime_error("expected ParseError for: " + src);
}

} // namespace

TEST(literal_forms) {
  auto s = kEmpty;
  auto e = parse("255:8", s);
  CHECK_EQ(e->width, 8);
  CHECK_EQ(eval(*e, {}), 255);
  CHECK_EQ(eval(*parse("0xFF:8", s), {}), 255);
  CHECK_EQ(eval(*parse("0b1111:8", s), {}), 15);
  CHECK_EQ(eval(*parse("0xdeadbeef:32", s), {}), 0xdeadbeefULL);
  // Plain literals take the minimal width, clamped to 8 bits.
  CHECK_EQ(parse("7", s)->width, 8);
  CHECK_EQ(parse("300", s)->width, 9);
  CHECK_EQ(parse("0x100", s)->width, 9);
  CHECK_EQ(parse("0", s)->width, 8);
}

TEST(literal_errors_carry_position) {
  auto s = kEmpty;
  CHECK_THROWS_AS(parse("256:8", s), ParseError);   // does not fit
  CHECK_THROWS_AS(parse("1:7", s), ParseError);     // width too small
  CHECK_THROWS_AS(parse("1:65", s), ParseError);    // width too large
  CHECK_THROWS_AS(parse("18446744073709551616", s), ParseError); // > 2^64-1
  CHECK_EQ(errPos("256:8", s), 0);
  CHECK_EQ(errPos("1:8 + 300:8", s), 6); // literal starts at byte 6
}

TEST(lex_error_positions) {
  auto s = schema({{"r0", 8}});
  CHECK_EQ(errPos("r0 + @", s), 5);
  CHECK_EQ(errPos("r0 & r0", s), 3);
  CHECK_EQ(errPos("  0x", s), 2);
  CHECK_EQ(errPos("r0 +", s), 4); // EOF position
  CHECK_EQ(errPos("r0 1:8", s), 3);
  CHECK_EQ(errPos("(r0", s), 3);
}

TEST(unknown_register_position) {
  auto s = schema({{"r0", 8}});
  CHECK_EQ(errPos("nope", s), 0);
  CHECK_EQ(errPos("r0 + nope", s), 5);
}

TEST(illegal_slices_rejected) {
  auto s = schema({{"r0", 8}, {"r1", 16}});
  CHECK_THROWS_AS(parse("r0[8:0]", s), ParseError);  // hi out of range
  CHECK_THROWS_AS(parse("r0[2:5]", s), ParseError);  // reversed
  CHECK_THROWS_AS(parse("r0[3:0]", s), ParseError);  // narrower than 8 bits
  CHECK_THROWS_AS(parse("r1[16:0]", s), ParseError); // hi out of range
  CHECK_EQ(errPos("r0[8:0]", s), 2);                 // '[' position
  CHECK_EQ(errPos("r0 + r1[16:0]", s), 7);
  // Legal slices parse fine.
  CHECK_EQ(parse("r0[7:0]", s)->width, 8);
  CHECK_EQ(parse("r1[15:8]", s)->width, 8);
  CHECK_EQ(parse("r1[15:0]", s)->width, 16);
}

TEST(concat_width_limits) {
  auto s = schema({{"a", 64}, {"b", 8}, {"c", 56}});
  CHECK_THROWS_AS(parse("{a, b}", s), ParseError); // 72 bits
  CHECK_EQ(parse("{c, b}", s)->width, 64);
  CHECK_THROWS_AS(parse("{}", s), ParseError);
  CHECK_THROWS_AS(parse("{a", s), ParseError);
}

TEST(ternary_branch_widths_must_match) {
  auto s = schema({{"c", 8}, {"a", 8}, {"b", 16}});
  CHECK_THROWS_AS(parse("c ? a : b", s), ParseError);
  CHECK_EQ(errPos("c ? a : b", s), 2); // '?' position
  CHECK_EQ(parse("c ? a : a", s)->width, 8);
}

TEST(grouping_is_transparent) {
  auto s = schema({{"r0", 8}, {"r1", 8}, {"r2", 8}});
  CHECK(sameAst(*parse("r0", s), *parse("(r0)", s)));
  CHECK(sameAst(*parse("r0", s), *parse("((r0))", s)));
  CHECK(sameAst(*parse("r0 + r1", s), *parse("(r0 + r1)", s)));
  CHECK(sameAst(*parse("r0 + r1", s), *parse("((r0) + ((r1)))", s)));
  // Left associativity of '+' is unaffected by redundant grouping.
  CHECK(sameAst(*parse("r0 + r1 + r2", s), *parse("(r0 + r1) + r2", s)));
  CHECK(sameAst(*parse("r0 << r1 << r2", s), *parse("(r0 << r1) << r2", s)));
}

TEST(precedence) {
  auto s = kEmpty;
  CHECK_EQ(eval(*parse("2:8 + 1:8 << 1:8", s), {}), 6);  // (2+1)<<1
  CHECK_EQ(eval(*parse("1:8 << 2:8 + 1:8", s), {}), 8);  // 1<<(2+1)
  CHECK_EQ(eval(*parse("1:8 + 2:8 == 3:8", s), {}), 1);  // (1+2)==3
  CHECK_EQ(eval(*parse("0:8 || 1:8 && 0:8", s), {}), 0); // 0 || (1&&0)
  CHECK_EQ(eval(*parse("1:8 ? 2:8 : 3:8", s), {}), 2);
}

int main() { return tf::run(); }
