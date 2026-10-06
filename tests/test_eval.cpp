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

uint64_t run(const std::string& src, const Schema& s, const RegValues& v = {}) {
  return eval(*parse(src, s), v);
}

} // namespace

TEST(add_mod_result_width) {
  auto s = kEmpty;
  CHECK_EQ(run("255:8 + 1:8", s), 0);          // wraps mod 2^8
  CHECK_EQ(run("255:8 + 1:16", s), 256);       // wider result keeps carry
  CHECK_EQ(run("0xFFFFFFFFFFFFFFFF:64 + 1:64", s), 0);
  CHECK_EQ(run("0xFF:8 + 0xFF:8", s), 0xFE);
  CHECK_EQ(parse("255:8 + 1:8", s)->width, 8);
  CHECK_EQ(parse("255:8 + 1:16", s)->width, 16);
}

TEST(shifts) {
  auto s = kEmpty;
  CHECK_EQ(run("1:8 << 7:8", s), 128);
  CHECK_EQ(run("1:8 << 8:8", s), 0);   // amount >= width -> 0
  CHECK_EQ(run("1:8 << 1000:16", s), 0);
  CHECK_EQ(run("255:8 >> 7:8", s), 1);
  CHECK_EQ(run("255:8 >> 8:8", s), 0); // amount >= width -> 0
  CHECK_EQ(run("255:8 >> 255:8", s), 0);
  CHECK_EQ(run("0x8000:16 >> 15:8", s), 1);
  CHECK_EQ(run("3:8 << 0:8", s), 3);
  CHECK_EQ(parse("1:8 << 2:16", s)->width, 8); // result keeps value width
}

TEST(slices) {
  auto s = kEmpty;
  CHECK_EQ(run("0xABCD:16[15:8]", s), 0xAB);
  CHECK_EQ(run("0xABCD:16[7:0]", s), 0xCD);
  CHECK_EQ(run("0xFF:8[7:0]", s), 0xFF);
  CHECK_EQ(run("0x12345678:32[15:8]", s), 0x56);
  CHECK_EQ(run("0x12345678:32[23:8]", s), 0x3456);
}

TEST(concat) {
  auto s = kEmpty;
  CHECK_EQ(run("{0xAB:8, 0xCD:8}", s), 0xABCD);
  CHECK_EQ(parse("{0xAB:8, 0xCD:8}", s)->width, 16);
  CHECK_EQ(run("{1:8, 2:8, 3:8}", s), 0x010203);
  // Concatenation is associative across groupings.
  CHECK_EQ(run("{1:8, {2:8, 3:8}}", s), 0x010203);
  CHECK_EQ(run("{{1:8, 2:8}, 3:8}", s), 0x010203);
}

TEST(comparisons_and_logic) {
  auto s = kEmpty;
  CHECK_EQ(run("2:8 == 2:8", s), 1);
  CHECK_EQ(run("2:8 != 2:8", s), 0);
  CHECK_EQ(run("255:8 == 255:16", s), 1); // compared by value
  CHECK_EQ(run("3:8 && 5:8", s), 1);
  CHECK_EQ(run("3:8 && 0:8", s), 0);
  CHECK_EQ(run("0:8 || 5:8", s), 1);
  CHECK_EQ(run("0:8 || 0:8", s), 0);
  CHECK_EQ(parse("3:8 && 5:8", s)->width, 8);
}

TEST(ternary) {
  auto s = kEmpty;
  CHECK_EQ(run("1:8 ? 10:8 : 20:8", s), 10);
  CHECK_EQ(run("0:8 ? 10:8 : 20:8", s), 20);
  CHECK_EQ(run("2:8 ? 10:8 : 20:8", s), 10); // any nonzero is true
}

TEST(registers) {
  auto s = schema({{"r0", 8}, {"r1", 16}});
  CHECK_EQ(run("r0 + 1:8", s, {{"r0", 255}, {"r1", 0}}), 0);
  CHECK_EQ(run("{r0, r0}", s, {{"r0", 0xAB}}), 0xABAB);
  CHECK_EQ(run("r1[15:8]", s, {{"r1", 0xBEEF}}), 0xBE);
}

TEST(runtime_errors_on_illegal_values) {
  auto s = schema({{"r0", 8}});
  CHECK_THROWS_AS(run("r0", s, {{"r0", 256}}), RuntimeError); // too wide
  CHECK_THROWS_AS(run("r0", s, {}), RuntimeError);            // missing
  CHECK_THROWS_AS(run("r0 + 1:8", s, {{"r0", 1 << 30}}), RuntimeError);
}

TEST(short_circuit_skips_illegal_values) {
  auto s = schema({{"bad", 8}});
  RegValues v{{"bad", 300}}; // illegal: does not fit in 8 bits
  // Unexecuted branches must not raise.
  CHECK_EQ(run("1:8 ? 42:8 : bad", s, v), 42);
  CHECK_EQ(run("0:8 ? bad : 7:8", s, v), 7);
  CHECK_EQ(run("0:8 && bad", s, v), 0);
  CHECK_EQ(run("1:8 || bad", s, v), 1);
  CHECK_EQ(run("(1:8 == 1:8) || bad", s, v), 1);
  // Executed branches do raise.
  CHECK_THROWS_AS(run("1:8 ? bad : 7:8", s, v), RuntimeError);
  CHECK_THROWS_AS(run("1:8 && bad", s, v), RuntimeError);
  CHECK_THROWS_AS(run("0:8 || bad", s, v), RuntimeError);
}

TEST(grouping_does_not_change_semantics) {
  auto s = schema({{"a", 8}, {"b", 16}, {"c", 16}});
  RegValues v{{"a", 200}, {"b", 40000}, {"c", 12345}};
  CHECK_EQ(run("a + b + c", s, v), run("(a + b) + c", s, v));
  CHECK_EQ(run("a + b + c", s, v), run("a + (b + c)", s, v));
  CHECK_EQ(run("a + b + c", s, v), run("((a) + ((b + c)))", s, v));
  CHECK_EQ(run("{a, b}", s, v), run("{(a), ((b))}", s, v));
}

int main() { return tf::run(); }
