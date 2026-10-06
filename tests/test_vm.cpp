#include "regx/compiler.hpp"
#include "regx/eval.hpp"
#include "regx/parser.hpp"
#include "regx/verifier.hpp"
#include "regx/vm.hpp"

#include "test_framework.hpp"

using namespace regx;

namespace {

Schema schema(std::initializer_list<std::pair<std::string, uint8_t>> rs) {
  Schema s;
  s.regs.assign(rs);
  return s;
}

RegValues toMap(const Schema& s, const std::vector<uint64_t>& vals) {
  RegValues m;
  for (size_t i = 0; i < vals.size(); ++i) m[s.regs[i].first] = vals[i];
  return m;
}

// Runs the VM one instruction at a time; at every instruction boundary a
// copy is resumed to completion and must agree with the AST result.
void checkPausable(const std::string& src, const Schema& s,
                   const std::vector<uint64_t>& vals) {
  auto ast = parse(src, s);
  uint64_t want = eval(*ast, toMap(s, vals));
  Program prog = compile(*ast, s);
  CHECK(!prog.code.empty());

  VM vm(prog, vals);
  size_t steps = 0;
  while (vm.status() == VM::Status::Running) {
    VM resumed = vm; // pause here, resume elsewhere
    CHECK_EQ(resumed.run(), VM::Status::Done);
    CHECK_EQ(resumed.result(), want);
    vm.step();
    ++steps;
    CHECK(steps <= prog.code.size() * 4 + 16); // no runaway loops
  }
  CHECK_EQ(vm.status(), VM::Status::Done);
  CHECK_EQ(vm.result(), want);
  CHECK_EQ(vm.resultWidth(), ast->width);
}

Instr instr(OpCode op) {
  Instr i;
  i.op = op;
  return i;
}

Instr pushConst(uint64_t v, uint8_t w) {
  Instr i = instr(OpCode::PushConst);
  i.immValue = v;
  i.immWidth = w;
  return i;
}

Instr jump(OpCode op, uint32_t target) {
  Instr i = instr(op);
  i.immA = target;
  return i;
}

} // namespace

TEST(vm_matches_ast_on_suite) {
  auto s = schema({{"r0", 8}, {"r1", 16}, {"r2", 8}});
  RegValues vals{{"r0", 200}, {"r1", 40000}, {"r2", 3}};
  const char* cases[] = {
      "r0 + r1",
      "r0 + r2",
      "r1[15:8]",
      "{r0, r2}",
      "{r0, {r2, r0}}",
      "r0 << r2",
      "r1 >> r2",
      "r0 << 20:8",
      "r0 == 200:8",
      "r0 != r2",
      "r0 && r2",
      "r0 || 0:8",
      "0:8 || r2",
      "r2 ? r0 : r2",
      "0:8 ? r0 : r2",
      "(r0 + r2) << 1:8",
      "r1[15:8] == r0 ? {r0, r2} : {r2, r0}",
      "r0 + r1 + r2",
      "{r1[15:8], r1[7:0]} == r1",
  };
  for (const char* src : cases) {
    auto ast = parse(src, s);
    Program prog = compile(*ast, s);
    VM vm(prog, {200, 40000, 3});
    CHECK_EQ(vm.run(), VM::Status::Done);
    CHECK_EQ(vm.result(), eval(*ast, vals));
  }
}

TEST(pause_resume_at_every_instruction_boundary) {
  auto s = schema({{"r0", 8}, {"r1", 16}, {"r2", 8}});
  const char* cases[] = {
      "r0 + r1",
      "r2 ? {r0, r2} : {r2, r0}",
      "0:8 ? r0 : r2",
      "r0 && r2 || r0",
      "0:8 && r0",
      "1:8 || r0",
      "(r0 + r2) << r2 >> 1:8",
      "{r1[15:8], r1[7:0]}",
      "r0 == 200:8 ? r1 >> r2 : r1 << r2",
  };
  std::vector<std::vector<uint64_t>> vals = {
      {200, 40000, 3}, {0, 0, 0}, {255, 65535, 255}, {1, 1, 1}};
  for (const char* src : cases)
    for (const auto& v : vals) checkPausable(src, s, v);
}

TEST(short_circuit_avoids_runtime_errors) {
  auto s = schema({{"bad", 8}});
  std::vector<uint64_t> illegal{300}; // does not fit in 8 bits

  // Unexecuted branches never touch the illegal register.
  for (const char* src : {"0:8 ? bad : 42:8", "1:8 ? 42:8 : bad",
                          "0:8 && bad", "1:8 || bad"}) {
    auto ast = parse(src, s);
    Program prog = compile(*ast, s);
    VM vm(prog, illegal);
    CHECK_EQ(vm.run(), VM::Status::Done);
    CHECK_EQ(vm.result(), eval(*ast, RegValues{{"bad", 300}}));
  }
  // Executed branches raise, in both evaluators.
  for (const char* src : {"1:8 ? bad : 42:8", "0:8 ? 42:8 : bad",
                          "1:8 && bad", "0:8 || bad", "bad"}) {
    auto ast = parse(src, s);
    CHECK_THROWS_AS(eval(*ast, RegValues{{"bad", 300}}), RuntimeError);
    Program prog = compile(*ast, s);
    VM vm(prog, illegal);
    CHECK_EQ(vm.run(), VM::Status::Error);
    CHECK(!vm.error().empty());
  }
}

TEST(verifier_accepts_compiler_output) {
  auto s = schema({{"r0", 8}, {"r1", 16}});
  for (const char* src : {"r0", "r0 + r1", "r0 ? r1 : r1", "r0 && r1 || r0",
                          "{r0, r0}[15:8]", "r1 << r0 >> r0"}) {
    Program p = compile(*parse(src, s), s);
    CHECK_NOTHROW(verify(p));
  }
}

TEST(verifier_rejects_bad_jump_target_stack_type) {
  Program p;
  p.resultWidth = 8;
  // 0: push 1:8; 1: jf 3; 2: push 2:8; 3: halt
  // Fall-through reaches 3 with [8,8]; the jump reaches it with [8].
  p.code = {pushConst(1, 8), jump(OpCode::JumpIfFalse, 3), pushConst(2, 8),
            instr(OpCode::Halt)};
  CHECK_THROWS_AS(verify(p), VerifyError);
}

TEST(verifier_rejects_width_mismatch_at_merge) {
  Program p;
  p.resultWidth = 8;
  // 0: push 1:8; 1: jf 4; 2: push 2:16; 3: jmp 5; 4: push 3:8; 5: halt
  // Reaching 5 with [16] vs [8].
  p.code = {pushConst(1, 8), jump(OpCode::JumpIfFalse, 4), pushConst(2, 16),
            jump(OpCode::Jump, 5), pushConst(3, 8), instr(OpCode::Halt)};
  CHECK_THROWS_AS(verify(p), VerifyError);
}

TEST(verifier_rejects_out_of_range_and_misc) {
  Program base;
  base.resultWidth = 8;

  { // jump target out of range
    Program p = base;
    p.code = {pushConst(1, 8), jump(OpCode::JumpIfFalse, 99),
              instr(OpCode::Halt)};
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
  { // stack underflow
    Program p = base;
    p.code = {instr(OpCode::Add), instr(OpCode::Halt)};
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
  { // halt with wrong stack shape
    Program p = base;
    p.code = {pushConst(1, 8), pushConst(2, 8), instr(OpCode::Halt)};
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
  { // halt with wrong result width
    Program p = base;
    p.code = {pushConst(1, 16), instr(OpCode::Halt)};
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
  { // empty program
    Program p = base;
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
  { // constant wider than declared
    Program p = base;
    p.code = {pushConst(256, 8), instr(OpCode::Halt)};
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
  { // register slot out of range
    Program p = base;
    p.code = {instr(OpCode::LoadReg), instr(OpCode::Halt)};
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
  { // illegal slice in bytecode
    Program p = base;
    Instr sl = instr(OpCode::Slice);
    sl.immA = 9; // hi >= operand width
    sl.immB = 0;
    p.code = {pushConst(1, 8), sl, instr(OpCode::Halt)};
    CHECK_THROWS_AS(verify(p), VerifyError);
  }
}

TEST(vm_runtime_guards) {
  auto s = schema({{"r0", 8}});
  Program p = compile(*parse("r0 + 1:8", s), s);
  { // missing register value
    VM vm(p, {});
    CHECK_EQ(vm.run(), VM::Status::Error);
  }
  { // illegal register value
    VM vm(p, {999});
    CHECK_EQ(vm.run(), VM::Status::Error);
  }
  { // stepping after completion is a no-op
    VM vm(p, {7});
    CHECK_EQ(vm.run(), VM::Status::Done);
    CHECK_EQ(vm.result(), 8);
    CHECK_EQ(vm.step(), VM::Status::Done);
    CHECK_EQ(vm.result(), 8);
  }
}

TEST(disassemble_smoke) {
  auto s = schema({{"r0", 8}});
  Program p = compile(*parse("r0 ? 1:8 : 2:8", s), s);
  std::string d = p.disassemble();
  CHECK(d.find("jf") != std::string::npos);
  CHECK(d.find("halt") != std::string::npos);
  CHECK(d.find("r0") != std::string::npos);
}

int main() { return tf::run(); }
