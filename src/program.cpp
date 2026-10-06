#include "program.hpp"

#include <algorithm>
#include <cctype>
#include <sstream>

CmpOp negate(CmpOp op) {
    switch (op) {
        case CmpOp::Lt: return CmpOp::Ge;
        case CmpOp::Le: return CmpOp::Gt;
        case CmpOp::Eq: return CmpOp::Ne;
        case CmpOp::Ne: return CmpOp::Eq;
        case CmpOp::Ge: return CmpOp::Lt;
        case CmpOp::Gt: return CmpOp::Le;
    }
    return CmpOp::Eq;
}

std::string cmpToString(CmpOp op) {
    switch (op) {
        case CmpOp::Lt: return "<";
        case CmpOp::Le: return "<=";
        case CmpOp::Eq: return "==";
        case CmpOp::Ne: return "!=";
        case CmpOp::Ge: return ">=";
        case CmpOp::Gt: return ">";
    }
    return "?";
}

std::string instrToString(const Instruction& ins) {
    std::ostringstream os;
    switch (ins.kind) {
        case Instruction::Kind::AssignConst:
            os << ins.var << " = " << ins.imm;
            break;
        case Instruction::Kind::AssignVar:
            os << ins.var << " = " << ins.src;
            break;
        case Instruction::Kind::AddConst:
            os << ins.var << " = " << ins.src << " + " << ins.imm;
            break;
        case Instruction::Kind::SubConst:
            os << ins.var << " = " << ins.src << " - " << ins.imm;
            break;
        case Instruction::Kind::CondGoto:
            os << "if " << ins.var << " " << cmpToString(ins.cmp) << " " << ins.imm
               << " goto " << ins.target;
            break;
        case Instruction::Kind::Goto:
            os << "goto " << ins.target;
            break;
        case Instruction::Kind::Halt:
            os << "halt";
            break;
    }
    return os.str();
}

int Program::labelPc(const std::string& name) const {
    auto it = labels.find(name);
    return it == labels.end() ? -1 : it->second;
}

namespace {

bool isIdent(const std::string& s) {
    if (s.empty() || !(std::isalpha((unsigned char)s[0]) || s[0] == '_')) return false;
    return std::all_of(s.begin(), s.end(),
                       [](char c) { return std::isalnum((unsigned char)c) || c == '_'; });
}

bool parseInt(const std::string& s, int& out) {
    if (s.empty()) return false;
    size_t pos = 0;
    try {
        out = std::stoi(s, &pos);
    } catch (...) {
        return false;
    }
    return pos == s.size();
}

bool parseCmp(const std::string& s, CmpOp& op) {
    if (s == "<") op = CmpOp::Lt;
    else if (s == "<=") op = CmpOp::Le;
    else if (s == "==") op = CmpOp::Eq;
    else if (s == "!=") op = CmpOp::Ne;
    else if (s == ">=") op = CmpOp::Ge;
    else if (s == ">") op = CmpOp::Gt;
    else return false;
    return true;
}

void collectVars(Program& prog) {
    for (const Instruction& ins : prog.code) {
        if (!ins.var.empty()) prog.varNames.push_back(ins.var);
        if (!ins.src.empty()) prog.varNames.push_back(ins.src);
    }
    std::sort(prog.varNames.begin(), prog.varNames.end());
    prog.varNames.erase(std::unique(prog.varNames.begin(), prog.varNames.end()),
                        prog.varNames.end());
}

} // namespace

Program parseProgram(const std::string& text, std::string& error, bool& ok) {
    Program prog;
    ok = true;
    std::istringstream in(text);
    std::string line;
    int lineNo = 0;

    auto fail = [&](const std::string& msg) {
        error = "line " + std::to_string(lineNo) + ": " + msg;
        ok = false;
    };

    while (ok && std::getline(in, line)) {
        ++lineNo;
        auto hash = line.find('#');
        if (hash != std::string::npos) line.erase(hash);
        std::istringstream ls(line);
        std::vector<std::string> tok;
        for (std::string t; ls >> t;) tok.push_back(t);
        if (tok.empty()) continue;

        // label line: "name:" possibly followed by nothing else
        if (tok.size() == 1 && tok[0].size() > 1 && tok[0].back() == ':') {
            std::string name = tok[0].substr(0, tok[0].size() - 1);
            if (!isIdent(name)) {
                fail("bad label name '" + name + "'");
            } else if (prog.labels.count(name)) {
                fail("duplicate label '" + name + "'");
            } else {
                prog.labels[name] = static_cast<int>(prog.code.size());
            }
            continue;
        }

        Instruction ins;
        if (tok[0] == "halt" && tok.size() == 1) {
            ins.kind = Instruction::Kind::Halt;
        } else if (tok[0] == "goto" && tok.size() == 2 && isIdent(tok[1])) {
            ins.kind = Instruction::Kind::Goto;
            ins.target = tok[1];
        } else if (tok[0] == "if" && tok.size() == 6 && tok[4] == "goto" &&
                   isIdent(tok[1]) && isIdent(tok[5])) {
            int imm = 0;
            CmpOp op;
            if (!parseCmp(tok[2], op) || !parseInt(tok[3], imm)) {
                fail("malformed condition");
                break;
            }
            ins.kind = Instruction::Kind::CondGoto;
            ins.var = tok[1];
            ins.cmp = op;
            ins.imm = imm;
            ins.target = tok[5];
        } else if (tok.size() >= 3 && isIdent(tok[0]) && tok[1] == "=") {
            ins.var = tok[0];
            int imm = 0;
            if (tok.size() == 3 && parseInt(tok[2], imm)) {
                ins.kind = Instruction::Kind::AssignConst;
                ins.imm = imm;
            } else if (tok.size() == 3 && isIdent(tok[2])) {
                ins.kind = Instruction::Kind::AssignVar;
                ins.src = tok[2];
            } else if (tok.size() == 5 && isIdent(tok[2]) &&
                       (tok[3] == "+" || tok[3] == "-") && parseInt(tok[4], imm)) {
                ins.kind = tok[3] == "+" ? Instruction::Kind::AddConst
                                         : Instruction::Kind::SubConst;
                ins.src = tok[2];
                ins.imm = imm;
            } else {
                fail("malformed assignment");
                break;
            }
        } else {
            fail("unrecognized statement");
            break;
        }
        prog.code.push_back(ins);
    }

    if (!ok) return prog;
    if (prog.code.empty()) {
        error = "empty program";
        ok = false;
        return prog;
    }
    for (const Instruction& ins : prog.code) {
        if ((ins.kind == Instruction::Kind::Goto || ins.kind == Instruction::Kind::CondGoto) &&
            prog.labelPc(ins.target) < 0) {
            error = "unknown label '" + ins.target + "'";
            ok = false;
            return prog;
        }
    }
    collectVars(prog);
    return prog;
}
