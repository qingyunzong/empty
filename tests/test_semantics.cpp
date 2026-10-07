#include "check.hpp"

#include <rex/rex.hpp>

#include <cstdint>
#include <string>
#include <vector>

using namespace rex;

static const std::vector<RegDecl> kRegs = {
    {"r0", 8}, {"r1", 8}, {"ru", 8}, {"g", 64}, {"h", 64}};

static EvalResult run(const std::string& src, const RegFile& rf) {
  return eval(Parser(src, kRegs).parse(), rf);
}

static void expect_value(const std::string& src, const RegFile& rf,
                         uint8_t width, uint64_t bits) {
  const EvalResult r = run(src, rf);
  if (const auto* v = std::get_if<Value>(&r)) {
    CHECK(v->width == width);
    CHECK(v->bits == bits);
  } else {
    CHECK(!"unexpected runtime error");
  }
}

static void expect_error(const std::string& src, const RegFile& rf,
                         const std::string& needle) {
  const EvalResult r = run(src, rf);
  if (const auto* e = std::get_if<RuntimeError>(&r)) {
    CHECK(e->msg.find(needle) != std::string::npos);
  } else {
    CHECK(!"expected runtime error");
  }
}

int main() {
  RegFile rf = RegFile::from_decls(kRegs);

  // Addition is modulo the result width.
  rf.clear();
  rf.write("r0", 200);
  rf.write("r1", 100);
  expect_value("r0 + r1", rf, 8, 44);
  rf.write("g", UINT64_MAX);
  rf.write("h", 1);
  expect_value("g + h", rf, 64, 0); // wraps mod 2^64

  // Shifts: amounts at or beyond the width yield zero.
  rf.clear();
  rf.write("r0", 1);
  rf.write("r1", 7);
  expect_value("r0 << r1", rf, 8, 128);
  rf.write("r1", 8);
  expect_value("r0 << r1", rf, 8, 0);
  rf.write("r1", 255);
  expect_value("r0 << r1", rf, 8, 0);
  rf.write("r0", 0x80);
  rf.write("r1", 7);
  expect_value("r0 >> r1", rf, 8, 1);
  rf.write("r1", 8);
  expect_value("r0 >> r1", rf, 8, 0);
  rf.write("g", 1);
  rf.write("h", 63);
  expect_value("g << h", rf, 64, uint64_t{1} << 63);
  rf.write("h", 64);
  expect_value("g << h", rf, 64, 0);
  rf.write("g", UINT64_MAX);
  expect_value("g >> h", rf, 64, 0);

  // Slices and concatenation.
  rf.clear();
  rf.write("r0", 0xAB);
  rf.write("r1", 0x34);
  expect_value("r0[3:0]", rf, 4, 0xB);
  expect_value("r0[7:4]", rf, 4, 0xA);
  expect_value("r0[4]", rf, 1, 0);
  expect_value("r0[5]", rf, 1, 1);
  expect_value("{r0, r1}", rf, 16, 0xAB34);
  expect_value("{r0[3:0], r1[3:0]}", rf, 8, 0xB4);
  expect_value("{r0, r0, r0, r0, r0, r0, r0, r0}", rf, 64,
               0xABABABABABABABABull);

  // Comparisons and logical operators yield 1-bit results.
  rf.clear();
  rf.write("r0", 5);
  rf.write("r1", 5);
  expect_value("r0 == r1", rf, 1, 1);
  expect_value("r0 != r1", rf, 1, 0);
  rf.write("r1", 6);
  expect_value("r0 == r1", rf, 1, 0);
  expect_value("r0 && r1", rf, 1, 1);
  rf.write("r1", 0);
  expect_value("r0 && r1", rf, 1, 0);
  expect_value("r0 || r1", rf, 1, 1);
  rf.write("r0", 0);
  expect_value("r0 || r1", rf, 1, 0);

  // Conditional operator.
  rf.clear();
  rf.write("r0", 1);
  rf.write("r1", 42);
  expect_value("r0 ? r1 : 8'd7", rf, 8, 42);
  rf.write("r0", 0);
  expect_value("r0 ? r1 : 8'd7", rf, 8, 7);

  // Short-circuit: illegal values in unexecuted branches stay quiet.
  rf.clear();
  rf.write("r0", 1); // ru is unwritten
  expect_value("r0 || ru", rf, 1, 1);
  rf.write("r0", 0);
  expect_value("r0 && ru", rf, 1, 0);
  rf.write("r0", 5);
  expect_value("r0 ? r0 : ru", rf, 8, 5);
  rf.write("r0", 0);
  rf.write("r1", 9);
  expect_value("r1 ? r1 : ru", rf, 8, 9);

  // The same illegal values error when the branch does execute.
  rf.clear();
  rf.write("r0", 1);
  expect_error("r0 && ru", rf, "ru");
  rf.write("r0", 0);
  expect_error("r0 || ru", rf, "ru");
  expect_error("r0 ? r0 : ru", rf, "ru");
  expect_error("ru", rf, "ru");
  expect_error("ru + ru", rf, "ru");

  return check::summary("test_semantics");
}
