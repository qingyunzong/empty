#include "check.hpp"

#include <rex/rex.hpp>

#include <cstdint>
#include <string>
#include <vector>

using namespace rex;

static const std::vector<RegDecl> kRegs = {
    {"r0", 8}, {"r1", 8}, {"r2", 16}, {"ru", 8}, {"g", 64}};

static Program compile_checked(const std::string& src) {
  Program p = compile(Parser(src, kRegs).parse(), kRegs);
  const auto err = verify(p);
  if (err) {
    std::fprintf(stderr, "verify failed for '%s': %s\n", src.c_str(),
                 err->c_str());
    CHECK(!"verify failed");
  }
  return p;
}

// Runs the program, and at every instruction boundary snapshots the VM
// and resumes the copy to completion: every resume must agree with the
// straight run and with direct AST evaluation.
static void check_boundaries(const std::string& src, const RegFile& rf) {
  const Program p = compile_checked(src);
  const EvalResult want = eval(Parser(src, kRegs).parse(), rf);

  VM whole(p, rf);
  const VM::Status whole_status = whole.run();

  VM vm(p, rf);
  while (vm.status() == VM::Status::Paused) {
    VM copy = vm; // resume from this exact instruction boundary
    const VM::Status s = copy.run();
    CHECK(s == whole_status);
    if (s == VM::Status::Done && whole_status == VM::Status::Done)
      CHECK(value_eq(copy.result(), whole.result()));
    vm.step();
  }
  CHECK(vm.status() == whole_status);

  // Bounded fuel runs must compose to the same outcome.
  for (uint64_t fuel = 0; fuel <= p.code.size() + 1; ++fuel) {
    VM a(p, rf);
    a.run(fuel);
    a.run();
    CHECK(a.status() == whole_status);
    if (a.status() == VM::Status::Done && whole_status == VM::Status::Done)
      CHECK(value_eq(a.result(), whole.result()));
  }

  // And the VM agrees with the AST evaluator.
  if (const auto* v = std::get_if<Value>(&want)) {
    CHECK(whole_status == VM::Status::Done);
    if (whole_status == VM::Status::Done)
      CHECK(value_eq(whole.result(), *v));
  } else {
    CHECK(whole_status == VM::Status::Error);
    CHECK(whole.error() == std::get<RuntimeError>(want).msg);
  }
}

static void check_program(const std::string& src,
                          std::vector<std::pair<const char*, uint64_t>> ins) {
  RegFile rf = RegFile::from_decls(kRegs);
  for (const auto& [name, v] : ins)
    rf.write(name, v);
  check_boundaries(src, rf);
}

int main() {
  // Straight-line programs.
  check_program("r0 + r1", {{"r0", 200}, {"r1", 100}});
  check_program("r0 << r1", {{"r0", 1}, {"r1", 8}});
  check_program("r0 >> r1", {{"r0", 255}, {"r1", 3}});
  check_program("{r0, r1}", {{"r0", 0x12}, {"r1", 0x34}});
  check_program("{r0, r1}[11:4]", {{"r0", 0xAB}, {"r1", 0xCD}});
  check_program("r0 == r1", {{"r0", 7}, {"r1", 7}});
  check_program("g + g", {{"g", UINT64_MAX}});
  check_program("r2 + r2", {{"r2", 0xFFFF}});

  // Short-circuit conditionals exercise the jump machinery.
  check_program("r0 && r1", {{"r0", 0}, {"r1", 5}});
  check_program("r0 && r1", {{"r0", 3}, {"r1", 0}});
  check_program("r0 || r1", {{"r0", 0}, {"r1", 5}});
  check_program("r0 || r1", {{"r0", 3}, {"r1", 5}});
  check_program("r0 ? r1 + r0 : r1", {{"r0", 1}, {"r1", 10}});
  check_program("r0 ? r1 + r0 : r1", {{"r0", 0}, {"r1", 10}});
  check_program("(r0 == r1) ? {r0, r0} : {r1, r1}",
                {{"r0", 9}, {"r1", 9}});
  check_program("(r0 == r1) ? {r0, r0} : {r1, r1}",
                {{"r0", 9}, {"r1", 4}});

  // Illegal values in unexecuted branches produce no runtime error,
  // whether the branch is skipped by &&, ||, or ?:.
  check_program("r0 || ru", {{"r0", 1}});
  check_program("r0 && ru", {{"r0", 0}});
  check_program("r0 ? r1 : ru", {{"r0", 1}, {"r1", 77}});
  check_program("(r0 == r0) || (ru == ru)", {{"r0", 0}});
  // ...but they do error once the branch executes.
  check_program("r0 || ru", {{"r0", 0}});
  check_program("r0 && ru", {{"r0", 1}});
  check_program("r0 ? r1 : ru", {{"r0", 0}, {"r1", 77}});
  check_program("ru", {});

  // Verifier rejects ill-formed bytecode.
  {
    Program p;
    p.result_width = 8;
    p.regs = kRegs;

    p.code = {};
    CHECK(verify(p).has_value()); // empty program

    p.code = {Instr{Op::Add, 8, 0, 0}};
    CHECK(verify(p).has_value()); // stack underflow

    p.code = {Instr{Op::PushConst, 8, 1, 0}};
    CHECK(verify(p).has_value()); // falls off the end

    p.code = {Instr{Op::Halt, 0, 0, 0}};
    CHECK(verify(p).has_value()); // empty stack at halt

    p.code = {Instr{Op::PushConst, 8, 1, 0}, Instr{Op::PushConst, 8, 2, 0},
              Instr{Op::Halt, 0, 0, 0}};
    CHECK(verify(p).has_value()); // two values at halt

    p.code = {Instr{Op::Jmp, 0, 99, 0}};
    CHECK(verify(p).has_value()); // jump target out of range

    // Jump entry 3 is reached with [] from the Jz and with [8] from
    // the fall-through: stack types disagree.
    p.code = {Instr{Op::PushConst, 8, 1, 0}, Instr{Op::Jz, 0, 3, 0},
              Instr{Op::PushConst, 8, 2, 0}, Instr{Op::Halt, 0, 0, 0}};
    const auto mismatch = verify(p);
    CHECK(mismatch.has_value());
    if (mismatch)
      CHECK(mismatch->find("jump entry 3") != std::string::npos);

    // Operand widths must match the instruction's type.
    p.code = {Instr{Op::PushConst, 8, 1, 0}, Instr{Op::PushConst, 16, 2, 0},
              Instr{Op::Add, 8, 0, 0}, Instr{Op::Halt, 0, 0, 0}};
    CHECK(verify(p).has_value());

    // A well-formed diamond verifies.
    p.code = {Instr{Op::PushConst, 8, 0, 0}, Instr{Op::Jz, 0, 4, 0},
              Instr{Op::PushConst, 8, 1, 0}, Instr{Op::Jmp, 0, 5, 0},
              Instr{Op::PushConst, 8, 2, 0}, Instr{Op::Halt, 0, 0, 0}};
    CHECK(!verify(p).has_value());
  }

  return check::summary("test_vm");
}
