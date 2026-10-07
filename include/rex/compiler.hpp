#pragma once

#include "ast.hpp"
#include "bytecode.hpp"

#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace rex {

// Compiles an expression tree to stack bytecode. Conditional operators
// (&&, ||, ?:) compile to jumps so unchosen branches never execute.
inline Program compile(const Expr& root, std::vector<RegDecl> regs) {
  Program prog;
  prog.regs = std::move(regs);
  prog.result_width = root.width;
  auto& code = prog.code;

  struct Emitter {
    std::vector<Instr>& code;

    size_t emit(Instr ins) {
      code.push_back(ins);
      return code.size() - 1;
    }
    void patch(size_t at, uint64_t target) { code[at].imm = target; }
    size_t here() const { return code.size(); }

    void gen(const Expr& e) {
      switch (e.kind) {
      case Expr::Kind::Literal:
        emit(Instr{Op::PushConst, e.width, e.lit, 0});
        break;
      case Expr::Kind::Reg:
        emit(Instr{Op::Load, e.width, 0, e.reg});
        break;
      case Expr::Kind::Add:
        gen(e.kids[0]);
        gen(e.kids[1]);
        emit(Instr{Op::Add, e.width, 0, 0});
        break;
      case Expr::Kind::Shl:
        gen(e.kids[0]);
        gen(e.kids[1]);
        emit(Instr{Op::Shl, e.width, 0, 0});
        break;
      case Expr::Kind::Shr:
        gen(e.kids[0]);
        gen(e.kids[1]);
        emit(Instr{Op::Shr, e.width, 0, 0});
        break;
      case Expr::Kind::Eq:
        gen(e.kids[0]);
        gen(e.kids[1]);
        emit(Instr{Op::Eq, e.kids[0].width, 0, 0});
        break;
      case Expr::Kind::Ne:
        gen(e.kids[0]);
        gen(e.kids[1]);
        emit(Instr{Op::Ne, e.kids[0].width, 0, 0});
        break;
      case Expr::Kind::And: {
        // <a>; JZ false; <b>; JZ false; push 1; JMP end;
        // false: push 0; end:
        gen(e.kids[0]);
        const size_t j1 = emit(Instr{Op::Jz, 0, 0, 0});
        gen(e.kids[1]);
        const size_t j2 = emit(Instr{Op::Jz, 0, 0, 0});
        emit(Instr{Op::PushConst, 1, 1, 0});
        const size_t j3 = emit(Instr{Op::Jmp, 0, 0, 0});
        const size_t lfalse = here();
        patch(j1, lfalse);
        patch(j2, lfalse);
        emit(Instr{Op::PushConst, 1, 0, 0});
        patch(j3, here());
        break;
      }
      case Expr::Kind::Or: {
        // <a>; JZ rhs; push 1; JMP end; rhs: <b>; JZ false; push 1;
        // JMP end; false: push 0; end:
        gen(e.kids[0]);
        const size_t j1 = emit(Instr{Op::Jz, 0, 0, 0});
        emit(Instr{Op::PushConst, 1, 1, 0});
        const size_t j2 = emit(Instr{Op::Jmp, 0, 0, 0});
        const size_t lrhs = here();
        patch(j1, lrhs);
        gen(e.kids[1]);
        const size_t j3 = emit(Instr{Op::Jz, 0, 0, 0});
        emit(Instr{Op::PushConst, 1, 1, 0});
        const size_t j4 = emit(Instr{Op::Jmp, 0, 0, 0});
        const size_t lfalse = here();
        patch(j3, lfalse);
        emit(Instr{Op::PushConst, 1, 0, 0});
        const size_t lend = here();
        patch(j2, lend);
        patch(j4, lend);
        break;
      }
      case Expr::Kind::Cond: {
        // <c>; JZ else; <then>; JMP end; else: <else>; end:
        gen(e.kids[0]);
        const size_t j1 = emit(Instr{Op::Jz, 0, 0, 0});
        gen(e.kids[1]);
        const size_t j2 = emit(Instr{Op::Jmp, 0, 0, 0});
        const size_t lelse = here();
        patch(j1, lelse);
        gen(e.kids[2]);
        patch(j2, here());
        break;
      }
      case Expr::Kind::Slice:
        gen(e.kids[0]);
        emit(Instr{Op::Slice, e.width, e.slice_lo, e.slice_hi});
        break;
      case Expr::Kind::Concat:
        for (const auto& k : e.kids)
          gen(k);
        emit(Instr{Op::Concat, e.width, 0,
                   static_cast<uint32_t>(e.kids.size())});
        break;
      }
    }
  } emitter{code};

  emitter.gen(root);
  code.push_back(Instr{Op::Halt, 0, 0, 0});
  return prog;
}

} // namespace rex
