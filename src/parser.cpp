#include "program.h"

#include <algorithm>
#include <cctype>
#include <sstream>

static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

static bool isIdent(const std::string& s) {
    if (s.empty() || !(std::isalpha((unsigned char)s[0]) || s[0] == '_')) return false;
    for (char c : s)
        if (!(std::isalnum((unsigned char)c) || c == '_')) return false;
    return true;
}

static ParseError err(int lineno, const std::string& msg) {
    return ParseError("line " + std::to_string(lineno) + ": " + msg);
}

static uint16_t parseConst(const std::string& s, int lineno) {
    if (s.empty() || !std::all_of(s.begin(), s.end(),
                                  [](char c) { return std::isdigit((unsigned char)c); }))
        throw err(lineno, "expected constant 0..255, got '" + s + "'");
    unsigned long v = std::stoul(s);
    if (v > 255) throw err(lineno, "constant out of 8-bit range: " + s);
    return (uint16_t)v;
}

static CmpOp parseOp(const std::string& s, int lineno) {
    if (s == "<") return CmpOp::Lt;
    if (s == "<=") return CmpOp::Le;
    if (s == "==") return CmpOp::Eq;
    if (s == "!=") return CmpOp::Ne;
    if (s == ">=") return CmpOp::Ge;
    if (s == ">") return CmpOp::Gt;
    throw err(lineno, "unknown comparison operator '" + s + "'");
}

Program parseProgram(const std::string& source) {
    Program p;
    std::istringstream in(source);
    std::string line;
    int lineno = 0;

    auto regVar = [&](const std::string& name) {
        if (p.varIndex(name) < 0) p.vars.push_back(name);
    };

    while (std::getline(in, line)) {
        ++lineno;
        size_t hash = line.find('#');
        if (hash != std::string::npos) line = line.substr(0, hash);
        line = trim(line);
        if (line.empty()) continue;

        for (;;) { // peel leading labels
            size_t pos = line.find(':');
            if (pos == std::string::npos) break;
            std::string cand = line.substr(0, pos);
            if (!isIdent(cand)) break;
            if (p.labels.count(cand))
                throw err(lineno, "duplicate label '" + cand + "'");
            p.labels[cand] = (int)p.instrs.size();
            line = trim(line.substr(pos + 1));
            if (line.empty()) break;
        }
        if (line.empty()) continue;

        std::istringstream ts(line);
        std::vector<std::string> t;
        for (std::string tok; ts >> tok;) t.push_back(tok);

        Instr ins;
        ins.text = line;
        if (t[0] == "halt" && t.size() == 1) {
            ins.kind = Instr::Kind::Halt;
        } else if (t[0] == "goto" && t.size() == 2) {
            ins.kind = Instr::Kind::Goto;
            ins.label = t[1];
        } else if (t[0] == "input" && t.size() == 2 && isIdent(t[1])) {
            ins.kind = Instr::Kind::Input;
            ins.var = t[1];
            regVar(t[1]);
        } else if (t[0] == "if" && t.size() == 6 && t[4] == "goto") {
            if (!isIdent(t[1])) throw err(lineno, "expected variable after 'if'");
            ins.kind = Instr::Kind::CondGoto;
            ins.var = t[1];
            regVar(t[1]);
            ins.cmp = parseOp(t[2], lineno);
            ins.imm = parseConst(t[3], lineno);
            ins.label = t[5];
        } else if (t.size() >= 3 && isIdent(t[0]) && t[1] == "=") {
            ins.var = t[0];
            regVar(t[0]);
            if (t.size() == 3) {
                if (isIdent(t[2])) {
                    ins.kind = Instr::Kind::AssignCopy;
                    ins.src = t[2];
                    regVar(t[2]);
                } else {
                    ins.kind = Instr::Kind::AssignConst;
                    ins.imm = parseConst(t[2], lineno);
                }
            } else if (t.size() == 5 && isIdent(t[2]) && (t[3] == "+" || t[3] == "-")) {
                ins.kind = t[3] == "+" ? Instr::Kind::AssignAdd : Instr::Kind::AssignSub;
                ins.src = t[2];
                regVar(t[2]);
                ins.imm = parseConst(t[4], lineno);
            } else {
                throw err(lineno, "malformed assignment: " + line);
            }
        } else {
            throw err(lineno, "cannot parse: " + line);
        }
        p.instrs.push_back(ins);
    }

    for (auto& ins : p.instrs) {
        if (ins.kind == Instr::Kind::Goto || ins.kind == Instr::Kind::CondGoto) {
            auto it = p.labels.find(ins.label);
            if (it == p.labels.end())
                throw ParseError("unknown label '" + ins.label + "'");
            ins.target = it->second;
        }
    }
    if (p.instrs.empty()) throw ParseError("empty program");
    return p;
}
