#include "check.hpp"

#include <rex/parser.hpp>
#include <rex/rex.hpp>

#include <string>
#include <vector>

using namespace rex;

static const std::vector<RegDecl> kRegs = {
    {"r0", 8}, {"r1", 8}, {"r2", 16}, {"big", 64}};

static Expr parse(const std::string& src) {
  return Parser(src, kRegs).parse();
}

static void expect_error(const std::string& src, size_t pos) {
  try {
    Parser(src, kRegs).parse();
  } catch (const ParseError& e) {
    CHECK(e.pos == pos);
    return;
  }
  CHECK(!"expected ParseError");
}

int main() {
  // Result widths.
  CHECK(parse("r0").width == 8);
  CHECK(parse("r0 + r1").width == 8);
  CHECK(parse("r2").width == 16);
  CHECK(parse("255").width == 8);
  CHECK(parse("256").width == 9);
  CHECK(parse("8'hff").width == 8);
  CHECK(parse("8'd255").width == 8);
  CHECK(parse("8'b1010").width == 8);
  CHECK(parse("64'hffffffffffffffff").width == 64);
  CHECK(parse("r0[3:0]").width == 4);
  CHECK(parse("r0[4]").width == 1);
  CHECK(parse("{r0, r1}").width == 16);
  CHECK(parse("r0 == r1").width == 1);
  CHECK(parse("r0 && r1").width == 1);
  CHECK(parse("r0 || r1").width == 1);
  CHECK(parse("r0 ? r1 : r0").width == 8);
  CHECK(parse("r0 << r1").width == 8);
  CHECK(parse("r2 << r0").width == 16);

  // Grouping and whitespace do not change semantics.
  CHECK(ast_equal(parse("(r0 + r1)"), parse("r0 + r1")));
  CHECK(ast_equal(parse("((r0))"), parse("r0")));
  CHECK(ast_equal(parse("  r0\t+\n r1  "), parse("r0+r1")));
  CHECK(ast_equal(parse("((r0 + r1) + r0) + r1"),
                  parse("r0 + r1 + r0 + r1")));
  CHECK(!ast_equal(parse("r0 + (r1 << r0)"), parse("(r0 + r1) << r0")));

  // Error positions are byte offsets into the source.
  expect_error("r0 + ", 5);        // end of input after operator
  expect_error("r0 + @", 5);       // bad character
  expect_error("r0 r1", 3);        // trailing input
  expect_error("r0[8:0]", 2);      // slice above width
  expect_error("r0[3:5]", 2);      // hi < lo
  expect_error("r0[64:0]", 2);     // way above width
  expect_error("r2[16:0]", 2);     // 16-bit reg, index 16 illegal
  expect_error("8'd256", 0);       // literal does not fit
  expect_error("4'hf", 0);         // width below 8
  expect_error("65'd0", 0);        // width above 64
  expect_error("8'b2", 3);         // invalid binary digit
  expect_error("18446744073709551616", 0); // 2^64 overflows
  expect_error("r9 + r0", 0);      // unknown register
  expect_error("r0 + r2", 3);      // width mismatch at '+'
  expect_error("r0 == r2", 3);     // width mismatch at '=='
  expect_error("r0 ? r1 : r2", 3); // branch width mismatch at '?'
  expect_error("{big, r0}", 0);    // concatenation over 64 bits
  expect_error("r0 & r1", 3);      // single '&' is not an operator
  expect_error("(r0", 3);          // missing ')'
  expect_error("{r0, r1", 7);      // missing '}'

  // Illegal slices are rejected; legal ones parse.
  CHECK(parse("r0[7:0]").width == 8);
  CHECK(parse("r0[0:0]").width == 1);
  CHECK(parse("r2[15:0]").width == 16);
  CHECK(parse("big[63:32]").width == 32);
  CHECK(parse("r0[7:4][1:0]").width == 2); // chained slices

  // Concatenation grouping is associative in value space.
  RegFile rf = RegFile::from_decls(kRegs);
  rf.write("r0", 0x12);
  rf.write("r1", 0x34);
  const Value a = std::get<Value>(eval(parse("{r0, {r1, r0}}"), rf));
  const Value b = std::get<Value>(eval(parse("{{r0, r1}, r0}"), rf));
  const Value c = std::get<Value>(eval(parse("{r0, r1, r0}"), rf));
  CHECK(value_eq(a, b));
  CHECK(value_eq(b, c));
  CHECK(c.width == 24 && c.bits == 0x123412);

  return check::summary("test_parser");
}
