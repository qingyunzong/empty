#include "regx/bytecode.hpp"

#include <sstream>

namespace regx {

std::string Program::disassemble() const {
  std::ostringstream os;
  for (size_t pc = 0; pc < code.size(); ++pc) {
    const Instr& i = code[pc];
    os << pc << ":\t";
    switch (i.op) {
      case OpCode::PushConst:
        os << "push " << i.immValue << ":" << unsigned(i.immWidth);
        break;
      case OpCode::LoadReg: {
        os << "load ";
        if (i.immA < regNames.size()) os << regNames[i.immA];
        else os << "r?" << i.immA;
        break;
      }
      case OpCode::Add: os << "add"; break;
      case OpCode::Shl: os << "shl"; break;
      case OpCode::Shr: os << "shr"; break;
      case OpCode::Slice: os << "slice " << i.immA << ":" << i.immB; break;
      case OpCode::Concat2: os << "concat2"; break;
      case OpCode::Eq: os << "eq"; break;
      case OpCode::Ne: os << "ne"; break;
      case OpCode::JumpIfFalse: os << "jf " << i.immA; break;
      case OpCode::JumpIfTrue: os << "jt " << i.immA; break;
      case OpCode::Jump: os << "jmp " << i.immA; break;
      case OpCode::Halt: os << "halt"; break;
    }
    os << "\n";
  }
  return os.str();
}

} // namespace regx
