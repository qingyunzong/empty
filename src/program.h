#pragma once

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

enum class CmpOp { Lt, Le, Eq, Ne, Ge, Gt };

struct Instr {
    enum class Kind { AssignConst, AssignCopy, AssignAdd, AssignSub,
                      Input, CondGoto, Goto, Halt };
    Kind kind = Kind::Halt;
    std::string var;      // destination / compared variable
    std::string src;      // source variable for copy/add/sub
    uint16_t imm = 0;     // constant, addend, or compared value
    CmpOp cmp = CmpOp::Eq;
    std::string label;    // jump label, resolved into target
    int target = -1;
    std::string text;     // original source line, for display
};

struct Program {
    std::vector<Instr> instrs;
    std::vector<std::string> vars;          // variable index = position
    std::map<std::string, int> labels;

    int varIndex(const std::string& name) const {
        for (size_t i = 0; i < vars.size(); ++i)
            if (vars[i] == name) return (int)i;
        return -1;
    }
};

struct ParseError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// Grammar (one instruction per line, '#' starts a comment):
//   label:                (may prefix any instruction)
//   input x               x ranges over all of [0,255]
//   x = 5                 constant assignment
//   x = y                 copy
//   x = y + 5             8-bit wrap-around add (x, y may coincide)
//   x = y - 5             8-bit wrap-around subtract
//   if x < 5 goto label   ops: < <= == != >= >
//   goto label
//   halt
Program parseProgram(const std::string& source);
