#pragma once

#include <map>
#include <string>
#include <vector>

enum class CmpOp { Lt, Le, Eq, Ne, Ge, Gt };

CmpOp negate(CmpOp op);
std::string cmpToString(CmpOp op);

struct Instruction {
    enum class Kind {
        AssignConst, // var = imm
        AssignVar,   // var = src
        AddConst,    // var = src + imm   (wrapping 8-bit)
        SubConst,    // var = src - imm   (wrapping 8-bit)
        CondGoto,    // if var <cmp> imm goto target (fall-through otherwise)
        Goto,        // goto target
        Halt,        // stop
    };

    Kind kind = Kind::Halt;
    std::string var;    // destination / compared variable
    std::string src;    // source variable (AssignVar/AddConst/SubConst)
    int imm = 0;        // immediate constant
    CmpOp cmp = CmpOp::Eq;
    std::string target; // jump label (CondGoto/Goto)
};

std::string instrToString(const Instruction& ins);

struct Program {
    std::vector<Instruction> code;
    std::map<std::string, int> labels; // label -> pc
    std::vector<std::string> varNames; // sorted, unique

    int labelPc(const std::string& name) const; // -1 if unknown
};

// Parses the mini language. On failure returns false and fills `error`.
// Grammar (one statement per line, '#' starts a comment):
//   label:
//   x = 42 | x = y | x = y + 3 | x = y - 3
//   if x < 10 goto label      (ops: < <= == != >= >)
//   goto label
//   halt
Program parseProgram(const std::string& text, std::string& error, bool& ok);
